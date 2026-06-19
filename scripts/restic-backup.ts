/**
 * Tier-2 offsite backup → restic → Backblaze B2.
 *
 * Backs up the machine-only operational state that is NOT in git and NOT
 * recoverable elsewhere:
 *   - mnemon shared fact graph   (~/nanoclaw-memory/.mnemon)   [consistent snapshot]
 *   - central DB                 (data/v2.db)                  [consistent snapshot]
 *   - per-agent state            (groups/)                     CLAUDE.local.md, container.json,
 *                                                              ingestion cursors, conversations
 *   - small host state           (data/*.json, data/env, install-id)
 *   - local config               (.env, .claude/settings.local.json)
 *
 * Both SQLite DBs are snapshotted with better-sqlite3 `.backup()` (the in-tree
 * way — no torn-WAL risk while Zora/Iris are writing), exactly like
 * scripts/mnemon-backup.ts. The plaintext staging copies are deleted after the
 * encrypted restic backup completes, so no unencrypted DB copy is left on disk.
 *
 * restic encrypts client-side: B2 only ever sees ciphertext. The repo password
 * lives OUTSIDE the repo (RESTIC_PASSWORD_FILE) and must ALSO be saved in your
 * password manager — lose it and the backup is unrecoverable by design.
 *
 * Secrets/config are read from ~/.config/nanoclaw/restic.env (mode 600, NOT in
 * git). Required keys: RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE, B2_ACCOUNT_ID,
 * B2_ACCOUNT_KEY.
 *
 * Scheduled daily by ~/Library/LaunchAgents/com.nanoclaw.restic-backup.plist.
 * Run manually:  pnpm exec tsx scripts/restic-backup.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
function log(msg: string): void {
  console.log(`[restic-backup] ${new Date().toISOString()} ${msg}`);
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const HOME = os.homedir();
const CONFIG = path.join(HOME, '.config', 'nanoclaw', 'restic.env');

// --- load secrets/config from the out-of-repo env file ----------------------
function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) {
    console.error(
      `[restic-backup] config not found: ${file}\n` +
        `Create it (mode 600) with:\n` +
        `  RESTIC_REPOSITORY=b2:<bucket>:nanoclaw\n` +
        `  RESTIC_PASSWORD_FILE=${path.join(HOME, '.config/nanoclaw/restic-password')}\n` +
        `  B2_ACCOUNT_ID=<b2 keyID>\n` +
        `  B2_ACCOUNT_KEY=<b2 applicationKey>`,
    );
    process.exit(1);
  }
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvFile(CONFIG);

for (const k of ['RESTIC_REPOSITORY', 'RESTIC_PASSWORD_FILE', 'B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY']) {
  if (!process.env[k]) {
    console.error(`[restic-backup] missing required config key: ${k} (set it in ${CONFIG})`);
    process.exit(1);
  }
}
process.env.RESTIC_PASSWORD_FILE = expandHome(process.env.RESTIC_PASSWORD_FILE!);

function restic(args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync('restic', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e: any) {
    if (opts.allowFail) return (e.stdout || '') + (e.stderr || '');
    log(`restic ${args[0]} FAILED:\n${(e.stdout || '') + (e.stderr || '')}`);
    throw e;
  }
}

// --- 0. ensure the repo is initialized --------------------------------------
const probe = restic(['cat', 'config'], { allowFail: true });
if (/repository .* does not exist|unable to open config|no repository/i.test(probe)) {
  log('repository not initialized — running restic init');
  restic(['init']);
}

// --- 1. consistent SQLite snapshots into a temp staging dir ------------------
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-restic-'));
const mnemonDir = expandHome(process.env.MNEMON_DATA_DIR || '~/nanoclaw-memory/.mnemon');
const dbTargets: Array<[string, string]> = [
  [path.join(mnemonDir, 'data', 'default', 'mnemon.db'), path.join(stage, 'mnemon.db')],
  [path.join(REPO_ROOT, 'data', 'v2.db'), path.join(stage, 'v2.db')],
];
try {
  for (const [src, dest] of dbTargets) {
    if (!fs.existsSync(src)) {
      log(`WARN source DB missing, skipping: ${src}`);
      continue;
    }
    const db = new Database(src, { readonly: true });
    try {
      await db.backup(dest);
    } finally {
      db.close();
    }
    log(`staged consistent snapshot: ${path.basename(dest)} (${fs.statSync(dest).size} bytes)`);
  }

  // --- 2. run the encrypted backup ------------------------------------------
  const stamp = new Date().toISOString();
  const paths = [
    stage,
    path.join(REPO_ROOT, 'groups'),
    path.join(REPO_ROOT, '.env'),
    path.join(REPO_ROOT, '.claude', 'settings.local.json'),
    // small host state files (NOT the bulky/disposable session DBs)
    path.join(REPO_ROOT, 'data', 'install-id'),
    path.join(REPO_ROOT, 'data', 'env'),
    path.join(REPO_ROOT, 'data', 'telegram-pairings.json'),
    path.join(REPO_ROOT, 'data', 'upgrade-state.json'),
    path.join(REPO_ROOT, 'data', 'circuit-breaker.json'),
  ].filter((p) => fs.existsSync(p));

  const excludes = [
    '*.sock',
    '*-wal',
    '*-shm',
    'node_modules',
    '.DS_Store',
    'tmp',
    'runs', // iris per-run scratch
  ];

  const args = [
    'backup',
    ...paths,
    '--tag',
    'tier2',
    '--host',
    'nanoclaw',
    ...excludes.flatMap((e) => ['--exclude', e]),
  ];
  log(`backing up ${paths.length} paths …`);
  const out = restic(args);
  log(out.trim().split('\n').slice(-6).join('\n'));
  log(`backup complete @ ${stamp}`);

  // --- 3. retention + prune --------------------------------------------------
  restic([
    'forget',
    '--tag',
    'tier2',
    '--keep-daily',
    '14',
    '--keep-weekly',
    '8',
    '--keep-monthly',
    '12',
    '--prune',
  ]);
  log('retention applied (14 daily / 8 weekly / 12 monthly)');

  // --- 4. lightweight integrity check + summary -----------------------------
  const snaps = restic(['snapshots', '--tag', 'tier2', '--latest', '3'], { allowFail: true });
  log(`latest snapshots:\n${snaps.trim()}`);
} finally {
  // never leave plaintext DB copies on disk
  fs.rmSync(stage, { recursive: true, force: true });
}
