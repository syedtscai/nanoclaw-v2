/**
 * mnemon corruption watchdog — detect + auto-recover (credit-free, no LLM).
 *
 * WHY THIS EXISTS
 * The shared mnemon DB runs in WAL journal mode on a Docker bind mount accessed
 * by multiple containers (Iris + Zora) plus the host. WAL's shared-memory index
 * and POSIX locks are unreliable over macOS Docker mounts, which periodically
 * corrupts the B-tree ("2nd reference to page", "Child page depth differs").
 * The clean fix would be journal_mode=DELETE (what the session DBs use for
 * cross-mount safety), but mnemon (a compiled Go binary, v0.1.x) FORCES WAL on
 * every open and exposes no journal-mode config — so prevention is blocked at
 * the mnemon level. This watchdog is the pragmatic alternative: detect the
 * corruption fast and self-heal, since `.recover` reconstructs the DB losslessly
 * (verified) and integrity-checked daily backups exist as a fallback.
 *
 * WHAT IT DOES (only when corruption is actually present)
 *   1. quick_check the live DB. If ok → exit. Re-check once after a short delay
 *      so a transient mid-write read never triggers destructive action.
 *   2. Stop nanoclaw agent containers (no writer during repair).
 *   3. `sqlite3 .recover` into a fresh file; pick whichever of {recovered,
 *      latest integrity-ok backup} has MORE active facts (max data retention).
 *   4. Move the corrupt DB aside (preserved, timestamped) and swap the chosen
 *      DB in; verify integrity. Containers respawn on the next cron/DM.
 *   5. Alert host-side: a direct Telegram DM (bot token + owner chat from the
 *      central DB), a log line, and a marker file. No agent is spawned → no
 *      Claude credits.
 *
 * Scheduled hourly by ~/Library/LaunchAgents/com.nanoclaw.mnemon-watchdog.plist.
 * Run manually:  pnpm exec tsx scripts/mnemon-watchdog.ts
 * Set MNEMON_WATCHDOG_NO_ALERT=1 to log instead of sending Telegram (used in tests).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
function log(msg: string): void {
  console.log(`[mnemon-watchdog] ${new Date().toISOString()} ${msg}`);
}
function sleepSync(ms: number): void {
  execSync(`sleep ${(ms / 1000).toFixed(2)}`);
}

const dataDir = expandHome(process.env.MNEMON_DATA_DIR || '~/nanoclaw-memory/.mnemon');
const liveDb = path.join(dataDir, 'data', 'default', 'mnemon.db');
const backupDir = path.join(dataDir, 'backups');
const projectRoot = process.cwd();
const ts = new Date().toISOString().replace(/[:.]/g, '-');

/** quick_check result: 'ok', 'missing', or an error/issue string. */
function quickCheck(dbPath: string): string {
  if (!fs.existsSync(dbPath)) return 'missing';
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return String(db.pragma('quick_check', { simple: true }));
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    db?.close();
  }
}
function activeFacts(dbPath: string): number {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return (db.prepare('SELECT count(*) AS n FROM insights WHERE deleted_at IS NULL').get() as { n: number }).n;
  } catch {
    return -1;
  } finally {
    db?.close();
  }
}

function readEnvVal(key: string): string | undefined {
  try {
    for (const line of fs.readFileSync(path.join(projectRoot, '.env'), 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1 || t.slice(0, i).trim() !== key) continue;
      let v = t.slice(i + 1).trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
      return v || undefined;
    }
  } catch {
    /* no .env */
  }
  return undefined;
}
/** Owner's Telegram chat id from the central DB (platform_id `telegram:<id>`). */
function ownerTelegramChat(): string | undefined {
  let db: Database.Database | undefined;
  try {
    db = new Database(path.join(projectRoot, 'data', 'v2.db'), { readonly: true });
    const row = db
      .prepare("SELECT platform_id FROM messaging_groups WHERE channel_type='telegram' AND is_group=0 ORDER BY created_at LIMIT 1")
      .get() as { platform_id?: string } | undefined;
    const pid = row?.platform_id;
    return pid?.startsWith('telegram:') ? pid.slice('telegram:'.length) : pid;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

async function alert(text: string): Promise<void> {
  const body = `🛠️ mnemon watchdog\n${text}`;
  log(`ALERT: ${text.replace(/\n/g, ' ')}`);
  try {
    fs.writeFileSync(
      path.join(projectRoot, 'logs', 'mnemon-watchdog-last.json'),
      JSON.stringify({ at: new Date().toISOString(), text }, null, 2),
    );
  } catch {
    /* best-effort */
  }
  // macOS notification (best-effort).
  try {
    execSync(`osascript -e ${JSON.stringify(`display notification ${JSON.stringify(text)} with title "mnemon watchdog"`)}`);
  } catch {
    /* not at machine / no osascript */
  }
  if (process.env.MNEMON_WATCHDOG_NO_ALERT) {
    log('telegram alert suppressed (MNEMON_WATCHDOG_NO_ALERT set)');
    return;
  }
  try {
    const token = readEnvVal('TELEGRAM_BOT_TOKEN');
    const chat = ownerTelegramChat();
    if (!token || !chat) {
      log(`telegram alert skipped (token=${!!token}, chat=${!!chat})`);
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: body }),
    });
    log(`telegram alert sent (status ${res.status})`);
  } catch (err) {
    log(`telegram alert failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function stopAgentContainers(): void {
  try {
    const names = execSync("docker ps --format '{{.Names}}'", { encoding: 'utf-8' })
      .split('\n')
      .map((s) => s.trim())
      .filter((n) => /^nanoclaw-v2-/.test(n));
    for (const n of names) {
      try {
        execSync(`docker stop ${n}`, { stdio: 'ignore' });
        log(`stopped container ${n}`);
      } catch {
        /* ignore */
      }
    }
  } catch {
    log('docker ps failed — skipping container stop');
  }
}

async function main(): Promise<number> {
  const first = quickCheck(liveDb);
  if (first === 'ok') {
    log(`healthy (${activeFacts(liveDb)} active facts)`);
    return 0;
  }
  if (first === 'missing') {
    log(`FATAL: live DB missing at ${liveDb}`);
    await alert(`live mnemon DB missing at ${liveDb} — manual attention needed`);
    return 4;
  }
  // Confirm it isn't a transient mid-write read before doing anything destructive.
  log(`quick_check reported an issue: ${first.slice(0, 120)} — re-checking in 3s`);
  sleepSync(3000);
  const second = quickCheck(liveDb);
  if (second === 'ok') {
    log('healthy on re-check — first reading was transient, no action');
    return 0;
  }
  log(`CORRUPTION CONFIRMED on re-check: ${second.slice(0, 120)} — starting auto-recover`);

  stopAgentContainers();
  sleepSync(1500);

  // 1. .recover into a fresh file.
  const recovered = path.join(dataDir, 'data', 'default', `mnemon.recovered-${ts}.db`);
  let recOk = false;
  let recFacts = -1;
  try {
    execSync(`/usr/bin/sqlite3 ${JSON.stringify(liveDb)} ".recover" | /usr/bin/sqlite3 ${JSON.stringify(recovered)}`, {
      shell: '/bin/bash',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    recOk = quickCheck(recovered) === 'ok';
    recFacts = recOk ? activeFacts(recovered) : -1;
    log(`.recover → ${path.basename(recovered)} (integrity ${recOk ? 'ok' : 'FAILED'}, ${recFacts} active facts)`);
  } catch (err) {
    log(`.recover failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Latest integrity-ok backup as a fallback / comparison.
  let backup: string | undefined;
  let backupFacts = -1;
  try {
    const cands = fs
      .readdirSync(backupDir)
      .filter((f) => f.startsWith('mnemon-auto-') && f.endsWith('.db'))
      .sort()
      .reverse();
    for (const b of cands) {
      const p = path.join(backupDir, b);
      if (quickCheck(p) === 'ok') {
        backup = p;
        backupFacts = activeFacts(p);
        break;
      }
    }
  } catch {
    /* no backups dir */
  }
  if (backup) log(`latest ok backup: ${path.basename(backup)} (${backupFacts} active facts)`);
  else log('no integrity-ok backup found');

  // 3. Choose the most complete healthy source.
  let source: string | undefined;
  let why = '';
  if (recOk && recFacts >= backupFacts) {
    source = recovered;
    why = `recovered (${recFacts} facts ≥ backup ${backupFacts}) — freshest + most complete`;
  } else if (backup) {
    source = backup;
    why = `backup ${path.basename(backup)} (${backupFacts} facts; recover ${recOk ? `had only ${recFacts}` : 'FAILED'})`;
  } else if (recOk) {
    source = recovered;
    why = `recovered (${recFacts} facts) — no ok backup available`;
  }
  if (!source) {
    log('FATAL: recover failed AND no integrity-ok backup — cannot self-heal');
    await alert('mnemon DB is corrupt and AUTO-RECOVER FAILED (no clean .recover, no clean backup). Manual repair needed.');
    return 3;
  }
  log(`chosen source: ${why}`);

  // 4. Swap (preserve the corrupt original + stale wal/shm).
  const corruptDest = `${liveDb}.corrupt-${ts}`;
  fs.renameSync(liveDb, corruptDest);
  for (const ext of ['-wal', '-shm']) {
    const f = liveDb + ext;
    if (fs.existsSync(f)) fs.renameSync(f, `${corruptDest}${ext}`);
  }
  fs.copyFileSync(source, liveDb);
  const finalState = quickCheck(liveDb);
  const finalFacts = activeFacts(liveDb);
  log(`swapped in new live DB — integrity ${finalState}, ${finalFacts} active facts; corrupt original kept at ${path.basename(corruptDest)}`);

  if (finalState !== 'ok') {
    await alert(`auto-recover swapped a DB but it still fails integrity (${finalState}). Manual attention needed.`);
    return 5;
  }
  await alert(
    `Auto-recovered the mnemon DB after corruption.\nSource: ${why}\nNow: ${finalFacts} active facts, integrity ok.\nCorrupt original preserved as ${path.basename(corruptDest)}.`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  },
);
