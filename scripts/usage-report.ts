/**
 * Per-agent-group token/cost report — aggregates the `usage.jsonl` files that
 * the claude provider now appends per query (one line per Iris run / Zora turn).
 *
 * Usage:  pnpm exec tsx scripts/usage-report.ts [days]
 *   days — how many days of per-day breakdown to show (default 7)
 *
 * Reads groups/<folder>/usage.jsonl. No DB, no network — pure file aggregation.
 */
import fs from 'node:fs';
import path from 'node:path';

const days = Number(process.argv[2]) || 7;
const groupsDir = path.join(process.cwd(), 'groups');

interface Row {
  ts: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  total_cost_usd: number | null;
  num_turns: number | null;
}

interface Agg {
  runs: number;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  cost: number;
  costKnown: number; // # lines that carried a cost (vs null)
}

function emptyAgg(): Agg {
  return { runs: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, costKnown: 0 };
}
function add(a: Agg, r: Row): void {
  a.runs++;
  a.input += r.input_tokens || 0;
  a.output += r.output_tokens || 0;
  a.cacheCreate += r.cache_creation_input_tokens || 0;
  a.cacheRead += r.cache_read_input_tokens || 0;
  if (typeof r.total_cost_usd === 'number') {
    a.cost += r.total_cost_usd;
    a.costKnown++;
  }
}
const fmt = (n: number) => n.toLocaleString();
const usd = (a: Agg) => (a.costKnown ? `$${a.cost.toFixed(2)}${a.costKnown < a.runs ? '*' : ''}` : 'n/a');

const cutoff = Date.now() - days * 86_400_000;
const perGroup: Record<string, Agg> = {};
const perGroupDay: Record<string, Record<string, Agg>> = {};
const grand = emptyAgg();

if (!fs.existsSync(groupsDir)) {
  console.error(`groups dir not found: ${groupsDir} (run from repo root)`);
  process.exit(1);
}

for (const folder of fs.readdirSync(groupsDir)) {
  const file = path.join(groupsDir, folder, 'usage.jsonl');
  if (!fs.existsSync(file)) continue;
  perGroup[folder] ??= emptyAgg();
  perGroupDay[folder] ??= {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw.trim()) continue;
    let r: Row;
    try {
      r = JSON.parse(raw);
    } catch {
      continue;
    }
    add(perGroup[folder], r);
    add(grand, r);
    if (Date.parse(r.ts) >= cutoff) {
      const day = r.ts.slice(0, 10);
      perGroupDay[folder][day] ??= emptyAgg();
      add(perGroupDay[folder][day], r);
    }
  }
}

const groups = Object.keys(perGroup).sort((a, b) => perGroup[b].cost - perGroup[a].cost);
if (groups.length === 0) {
  console.log('No usage.jsonl found yet — run an agent (or wait for the next scheduled run) to populate it.');
  process.exit(0);
}

console.log('=== Per-group totals (all time) ===');
console.log('group                 runs     in-tok    out-tok   cache-rd    est-cost');
for (const g of groups) {
  const a = perGroup[g];
  console.log(
    `${g.padEnd(20)} ${String(a.runs).padStart(5)} ${fmt(a.input).padStart(10)} ${fmt(a.output).padStart(10)} ${fmt(a.cacheRead).padStart(10)}   ${usd(a).padStart(9)}`,
  );
}
console.log(`${'TOTAL'.padEnd(20)} ${String(grand.runs).padStart(5)} ${fmt(grand.input).padStart(10)} ${fmt(grand.output).padStart(10)} ${fmt(grand.cacheRead).padStart(10)}   ${usd(grand).padStart(9)}`);

console.log(`\n=== Per-day, last ${days} days ===`);
for (const g of groups) {
  const dayMap = perGroupDay[g];
  const dayKeys = Object.keys(dayMap).sort();
  if (dayKeys.length === 0) continue;
  console.log(`\n${g}:`);
  for (const d of dayKeys) {
    const a = dayMap[d];
    console.log(`  ${d}  runs=${String(a.runs).padStart(3)}  in=${fmt(a.input).padStart(9)}  out=${fmt(a.output).padStart(8)}  cost=${usd(a)}`);
  }
}
console.log('\n(* = some queries reported no cost; est-cost sums only those that did. Tokens are always complete.)');
