/**
 * Prune processed files from Iris's ingest inbox to keep disk bounded.
 *
 * Usage:
 *   pnpm exec tsx scripts/iris-ingest-prune.ts [--dry-run] [--archive] [--grace-hours=48]
 *
 * Iris's inbox (`~/nanoclaw-ingest/inbox`) is mounted READ-ONLY into her
 * container, so she cannot delete files she has processed — this host-side
 * job does it. A file is safe to remove once Iris has recorded it as
 * processed in her manifest (`groups/iris/ingest-manifest.jsonl`), because
 * her dedup is manifest-based (by sha256): deleting a processed file never
 * causes reprocessing and never produces a false "new file" wake.
 *
 * Source-agnostic: prunes ANY processed inbox file (Krisp meeting drops,
 * ad-hoc files, etc.). The manifest's per-file contract is
 * `{"file","sha256","processed_at","facts_written"}` (see the Inputs section
 * of groups/iris/CLAUDE.local.md).
 *
 * Flags:
 *   --dry-run        list what would be pruned; change nothing.
 *   --archive        gzip into <ingest>/processed/<file>.gz instead of deleting
 *                    (Krisp has no pull-retrieval, so this keeps verbatim copies).
 *   --grace-hours=N  only prune files processed more than N hours ago (default 48).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import { GROUPS_DIR } from '../src/config.js';
import { readEnvFile } from '../src/env.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const archive = args.includes('--archive');
const graceArg = args.find((a) => a.startsWith('--grace-hours='));
const graceHours = graceArg ? Math.max(0, parseInt(graceArg.split('=')[1], 10) || 0) : 48;

const env = readEnvFile(['INGEST_DIR']);
const base = process.env.INGEST_DIR || env.INGEST_DIR || path.join(os.homedir(), 'nanoclaw-ingest');
const inboxDir = path.join(base, 'inbox');
const processedDir = path.join(base, 'processed');
const manifestPath = path.join(GROUPS_DIR, 'iris', 'ingest-manifest.jsonl');

const now = Date.now();
const graceMs = graceHours * 3600_000;

if (!fs.existsSync(inboxDir)) {
  console.log(`Inbox ${inboxDir} does not exist — nothing to prune.`);
  process.exit(0);
}
if (!fs.existsSync(manifestPath)) {
  console.log(`Manifest ${manifestPath} not found — nothing recorded as processed; skipping.`);
  process.exit(0);
}

// Build filename -> newest processed_at(ms) from per-file manifest entries.
const processed = new Map<string, number>();
for (const line of fs.readFileSync(manifestPath, 'utf-8').split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    continue;
  }
  const file = entry.file;
  if (typeof file !== 'string' || !file) continue; // only per-file records carry "file"
  const name = path.basename(file);
  const ts = typeof entry.processed_at === 'string' ? Date.parse(entry.processed_at) : NaN;
  const prev = processed.get(name);
  const val = Number.isNaN(ts) ? 0 : ts;
  if (prev === undefined || val > prev) processed.set(name, val);
}

if (processed.size === 0) {
  console.log('No per-file processed records in manifest yet — nothing to prune.');
  process.exit(0);
}

let pruned = 0;
let skippedGrace = 0;
let skippedUnprocessed = 0;

for (const name of fs.readdirSync(inboxDir)) {
  const filePath = path.join(inboxDir, name);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    continue;
  }
  if (!stat.isFile()) continue;
  if (name.startsWith('.')) continue; // leave dotfiles (.DS_Store etc.)

  const processedAt = processed.get(name);
  if (processedAt === undefined) {
    skippedUnprocessed++;
    continue; // not yet processed — never touch
  }

  // Grace measured from processed_at when known, else the file's mtime.
  const reference = processedAt > 0 ? processedAt : stat.mtimeMs;
  if (now - reference < graceMs) {
    skippedGrace++;
    continue;
  }

  if (dryRun) {
    console.log(`[dry-run] would ${archive ? 'archive' : 'delete'}: ${name}`);
    pruned++;
    continue;
  }

  if (archive) {
    fs.mkdirSync(processedDir, { recursive: true });
    const gz = zlib.gzipSync(fs.readFileSync(filePath));
    fs.writeFileSync(path.join(processedDir, `${name}.gz`), gz);
  }
  fs.unlinkSync(filePath);
  pruned++;
  console.log(`${archive ? 'Archived+deleted' : 'Deleted'}: ${name}`);
}

console.log(
  `Prune complete (${dryRun ? 'dry-run' : 'live'}): ${pruned} ${archive ? 'archived' : 'deleted'}, ` +
    `${skippedGrace} within ${graceHours}h grace, ${skippedUnprocessed} not-yet-processed. Inbox: ${inboxDir}`,
);
