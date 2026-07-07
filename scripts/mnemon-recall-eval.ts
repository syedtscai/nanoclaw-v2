/**
 * mnemon-recall-eval.ts — deterministic recall-precision eval for the shared
 * mnemon graph memory.
 *
 * Answers "is retrieval actually working?" with a number instead of a feeling:
 *   1. Samples N random ACTIVE facts straight from mnemon.db (read-only).
 *   2. For each fact, derives a realistic query the way the agents do —
 *      entities first, plus a few content keywords.
 *   3. Runs `mnemon recall --limit 10` through the SAME binary + data dir the
 *      agents use (throwaway container; no host mnemon install needed).
 *   4. Scores hit@3 / hit@10 / MRR@10 (did the sampled fact come back, and
 *      how high?).
 *   5. Appends one JSON line to logs/mnemon-recall-eval.jsonl and prints a
 *      summary. With --telegram, also sends a one-line result to Mr. S's DM
 *      (same direct bot-API pattern as run-watchdog.sh).
 *
 * Interpretation: this measures self-retrieval (can a fact be found from a
 * query built out of its own entities/keywords) — an upper-bound proxy for
 * recall quality. A DROP over time is the signal that matters (store growth
 * degrading retrieval); the absolute number calibrates the baseline. Only
 * invest in better embeddings/re-ranking if this trends down.
 *
 * Scheduled monthly via ~/Library/LaunchAgents/com.nanoclaw.mnemon-recall-eval.plist
 * (5th of month, 04:10 SGT — after the 04:00 mnemon backup). Reference copy at
 * scripts/com.nanoclaw.mnemon-recall-eval.plist.
 *
 * Manual run:  pnpm exec tsx scripts/mnemon-recall-eval.ts [--n 25] [--telegram]
 *
 * Side-effect note: recall bumps access counters on returned facts (normal
 * mnemon behavior). At N=25/month against a ~1000-fact store this is noise.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MNEMON_DIR = path.join(os.homedir(), 'nanoclaw-memory/.mnemon');
const DB_PATH = path.join(MNEMON_DIR, 'data/default/mnemon.db');
const IMAGE = 'nanoclaw-agent-v2-9772a425:latest';
const OUT_PATH = path.join(ROOT, 'logs/mnemon-recall-eval.jsonl');
const CHAT_ID = '1000361138';

const argv = process.argv.slice(2);
const N = Number(argv[argv.indexOf('--n') + 1]) || 25;
const TELEGRAM = argv.includes('--telegram');

const STOPWORDS = new Set(
  'the a an and or of to in on for with is are was were be been has have had at by from as it its this that these those not no'.split(' '),
);

interface Row {
  id: string;
  content: string;
  entities: string;
  importance: number;
}

/** Derive a realistic recall query from a fact: entities first, then keywords. */
function deriveQuery(row: Row): string {
  let entities: string[] = [];
  try {
    entities = (JSON.parse(row.entities || '[]') as string[]).slice(0, 2);
  } catch {
    /* junk entities field — fall through to keywords */
  }
  const keywords = row.content
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !entities.some((e) => e.toLowerCase().includes(w)))
    .slice(0, 3);
  return [...entities, ...keywords].join(' ').trim() || row.content.slice(0, 60);
}

// Prefer the single-writer daemon when it's up (keeps ONE process on the DB);
// fall back to a throwaway container mounting the dir directly.
const DAEMON = 'http://127.0.0.1:8377';
let daemonUp = false;
try {
  daemonUp = JSON.parse(execFileSync('curl', ['-sS', '--max-time', '2', `${DAEMON}/health`], { encoding: 'utf8' })).ok === true;
} catch {
  /* daemon not running — use throwaway container */
}

function recall(query: string): string[] {
  let out: string;
  if (daemonUp) {
    const resp = JSON.parse(
      execFileSync(
        'curl',
        ['-sS', '--max-time', '35', '-X', 'POST', `${DAEMON}/run`, '-H', 'Content-Type: application/json', '--data-binary', '@-'],
        { encoding: 'utf8', input: JSON.stringify({ argv: ['recall', query, '--limit', '10'] }), maxBuffer: 16 * 1024 * 1024 },
      ),
    ) as { code: number; stdout: string; stderr: string };
    if (resp.code !== 0) throw new Error(`daemon recall exit ${resp.code}: ${resp.stderr.slice(0, 200)}`);
    out = resp.stdout;
  } else {
    out = execFileSync(
      'docker',
      [
        'run', '--rm', '--entrypoint', 'mnemon',
        '-v', `${MNEMON_DIR}:/home/node/.mnemon`,
        IMAGE, 'recall', query, '--limit', '10',
      ],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
  }
  const parsed = JSON.parse(out) as { results?: { insight: { id: string } }[] };
  return (parsed.results || []).map((r) => r.insight.id);
}

// ---- sample ------------------------------------------------------------------
const db = new Database(DB_PATH, { readonly: true });
const rows = db
  .prepare('SELECT id, content, entities, importance FROM insights WHERE deleted_at IS NULL ORDER BY RANDOM() LIMIT ?')
  .all(N) as Row[];
db.close();
if (rows.length === 0) {
  console.error('no active facts to sample');
  process.exit(1);
}

// ---- evaluate ----------------------------------------------------------------
let hit3 = 0;
let hit10 = 0;
let mrrSum = 0;
const misses: { id: string; query: string }[] = [];

for (const [i, row] of rows.entries()) {
  const query = deriveQuery(row);
  let ids: string[] = [];
  try {
    ids = recall(query);
  } catch (e) {
    console.error(`recall failed for "${query}": ${(e as Error).message.slice(0, 120)}`);
  }
  const rank = ids.indexOf(row.id); // 0-based; -1 = miss
  if (rank >= 0) {
    hit10++;
    if (rank < 3) hit3++;
    mrrSum += 1 / (rank + 1);
  } else {
    misses.push({ id: row.id, query });
  }
  process.stderr.write(`\r${i + 1}/${rows.length}`);
}
process.stderr.write('\n');

const result = {
  ts: new Date().toISOString(),
  n: rows.length,
  hit3: +(hit3 / rows.length).toFixed(3),
  hit10: +(hit10 / rows.length).toFixed(3),
  mrr10: +(mrrSum / rows.length).toFixed(3),
  misses,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.appendFileSync(OUT_PATH, JSON.stringify(result) + '\n');

const summary = `mnemon recall eval: hit@3 ${(result.hit3 * 100).toFixed(0)}% · hit@10 ${(result.hit10 * 100).toFixed(0)}% · MRR ${result.mrr10} (n=${result.n}, ${result.misses.length} misses)`;
console.log(summary);
console.log(JSON.stringify(result, null, 1));

if (TELEGRAM) {
  const token = (fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^TELEGRAM_BOT_TOKEN=(.*)$/m) || [])[1]
    ?.trim()
    .replace(/^["']|["']$/g, '');
  if (token) {
    execFileSync('curl', [
      '-sS', '--max-time', '30',
      `https://api.telegram.org/bot${token}/sendMessage`,
      '--data-urlencode', `chat_id=${CHAT_ID}`,
      '--data-urlencode', `text=📊 ${summary}`,
    ]);
    console.log('telegram summary sent');
  } else {
    console.error('TELEGRAM_BOT_TOKEN not found in .env — skipped telegram summary');
  }
}
