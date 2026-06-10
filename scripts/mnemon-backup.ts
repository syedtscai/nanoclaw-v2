/**
 * Daily mnemon backup — a CONSISTENT online snapshot of the shared mnemon DB,
 * verified, with rotation. Uses better-sqlite3's `.backup()` (the in-tree way;
 * the repo intentionally avoids the sqlite3 CLI) so the copy is safe even while
 * Zora/Iris are writing — no torn-WAL risk like a raw `cp`.
 *
 * Scheduled daily by ~/Library/LaunchAgents/com.nanoclaw.mnemon-backup.plist.
 * Run manually:  pnpm exec tsx scripts/mnemon-backup.ts
 *
 * Rotation only ever touches files named `mnemon-auto-*.db`; the hand-taken
 * milestone snapshots (mnemon-2026-06-…) are never deleted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const KEEP = 14; // retain this many most-recent auto-backups (≈2 weeks of dailies)
const PREFIX = 'mnemon-auto-';

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}
function log(msg: string): void {
  console.log(`[mnemon-backup] ${new Date().toISOString()} ${msg}`);
}

const dataDir = expandHome(process.env.MNEMON_DATA_DIR || '~/nanoclaw-memory/.mnemon');
const srcDb = path.join(dataDir, 'data', 'default', 'mnemon.db');
const backupDir = path.join(dataDir, 'backups');

if (!fs.existsSync(srcDb)) {
  console.error(`[mnemon-backup] source DB not found: ${srcDb}`);
  process.exit(1);
}
fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, 'Z'); // YYYY-MM-DDTHH-MM-SSZ
const dest = path.join(backupDir, `${PREFIX}${stamp}.db`);

// 1. Consistent online snapshot.
const src = new Database(srcDb, { readonly: true });
try {
  await src.backup(dest);
} finally {
  src.close();
}

// 2. Verify it opens, passes a quick integrity check, and has rows.
const check = new Database(dest, { readonly: true });
try {
  const integrity = check.pragma('quick_check', { simple: true }) as string;
  if (integrity !== 'ok') {
    console.error(`[mnemon-backup] integrity check FAILED on ${path.basename(dest)}: ${integrity}`);
    try {
      fs.unlinkSync(dest);
    } catch {
      /* leave the bad file for inspection if unlink fails */
    }
    process.exit(2);
  }
  const active = (check.prepare("SELECT count(*) AS n FROM insights WHERE deleted_at IS NULL").get() as { n: number }).n;
  const sizeMb = (fs.statSync(dest).size / 1e6).toFixed(2);
  log(`backup OK → ${path.basename(dest)} (${sizeMb} MB, ${active} active facts)`);
} finally {
  check.close();
}

// 3. Rotation — keep the newest KEEP auto-backups; never touch non-auto files.
const autos = fs
  .readdirSync(backupDir)
  .filter((f) => f.startsWith(PREFIX) && f.endsWith('.db'))
  .sort(); // ISO timestamps sort chronologically
for (const f of autos.slice(0, Math.max(0, autos.length - KEEP))) {
  fs.unlinkSync(path.join(backupDir, f));
  log(`pruned old backup ${f}`);
}
log(`retained ${Math.min(autos.length, KEEP)} auto-backups (keep=${KEEP})`);
