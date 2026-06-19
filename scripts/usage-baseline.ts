/**
 * scripts/usage-baseline.ts — per-agent baseline + proposed tripwires.
 *
 * Reads the durable usage_events ledger (built by src/usage-monitor from each
 * group's usage.jsonl) and prints, per agent over a rolling window:
 *   - cost + tokens per active day
 *   - avg/active-day baseline and a SUGGESTED spend tripwire (~4x baseline)
 *   - turn distribution (p50 / p95 / max num_turns) to size a maxTurns ceiling
 *
 * Observe-only: proposes thresholds, enforces nothing. Complements the all-time
 * scripts/usage-report.ts (which reads the flat usage.jsonl files directly).
 *
 * Usage:  pnpm exec tsx scripts/usage-baseline.ts [--days N]
 */
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';

const argv = process.argv.slice(2);
const di = argv.indexOf('--days');
const days = di >= 0 ? Math.max(1, parseInt(argv[di + 1] || '7', 10) || 7) : 7;

const db = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });

const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${Math.round(n)}`;
const pct = (arr: number[], p: number) =>
  arr.length ? arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : 0;

interface Ev {
  agent: string;
  provider: string;
  day: string;
  cost_usd: number | null;
  total_tokens: number;
  num_turns: number | null;
}

const rows = db
  .prepare(
    `SELECT COALESCE(ag.name, ue.agent_group_id) AS agent, ue.provider, ue.day,
            ue.cost_usd,
            (ue.input_tokens + ue.output_tokens + ue.cache_read_tokens + ue.cache_creation_tokens) AS total_tokens,
            ue.num_turns
       FROM usage_events ue
       LEFT JOIN agent_groups ag ON ag.id = ue.agent_group_id
      WHERE ue.day >= date('now', '-${days - 1} days')
      ORDER BY agent, ue.day`,
  )
  .all() as Ev[];

if (rows.length === 0) {
  console.log(`No usage recorded in the last ${days} day(s). Has the host run a usage-monitor sweep yet?`);
  process.exit(0);
}

const agents = new Map<string, Ev[]>();
for (const r of rows) {
  if (!agents.has(r.agent)) agents.set(r.agent, []);
  agents.get(r.agent)!.push(r);
}

console.log(`\nUsage baseline — last ${days} day(s)\n`);

for (const [agent, evs] of agents) {
  const providers = [...new Set(evs.map((e) => e.provider))].join(', ');
  const days_ = new Map<string, { cost: number; tokens: number; hasCost: boolean }>();
  const turns: number[] = [];
  let costKnown = false;
  for (const e of evs) {
    const d = days_.get(e.day) || { cost: 0, tokens: 0, hasCost: false };
    if (e.cost_usd != null) {
      d.cost += e.cost_usd;
      d.hasCost = true;
      costKnown = true;
    }
    d.tokens += e.total_tokens;
    days_.set(e.day, d);
    if (typeof e.num_turns === 'number') turns.push(e.num_turns);
  }
  turns.sort((a, b) => a - b);

  console.log(`■ ${agent}  [${providers}]  — ${evs.length} run(s), ${days_.size} active day(s)`);
  for (const [day, d] of [...days_.entries()].sort()) {
    console.log(`    ${day}   cost ${d.hasCost ? '$' + d.cost.toFixed(4) : '—'}   tokens ${fmt(d.tokens)}`);
  }

  const n = days_.size || 1;
  if (costKnown) {
    const totalCost = [...days_.values()].reduce((s, d) => s + d.cost, 0);
    const avg = totalCost / n;
    console.log(
      `    └ baseline ~$${avg.toFixed(4)}/day  →  suggested spend tripwire ~$${(avg * 4).toFixed(2)}/day (4× baseline)`,
    );
  } else {
    const totalTok = [...days_.values()].reduce((s, d) => s + d.tokens, 0);
    const avg = totalTok / n;
    console.log(
      `    └ baseline ~${fmt(avg)} tok/day  →  suggested token tripwire ~${fmt(avg * 4)} tok/day vs subscription limits (4× baseline)`,
    );
  }
  if (turns.length) {
    console.log(
      `    └ turns/run: p50 ${pct(turns, 50)}  p95 ${pct(turns, 95)}  max ${turns[turns.length - 1]}  →  suggested maxTurns ~${Math.max(20, turns[turns.length - 1] * 3)}`,
    );
  }
  console.log('');
}

console.log('Observe-only: thresholds are suggestions; nothing is enforced yet.\n');
