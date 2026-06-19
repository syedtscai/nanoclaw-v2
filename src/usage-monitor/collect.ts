/**
 * Cross-provider usage collector.
 *
 * Folds the unified per-group usage logs into the durable `usage_events`
 * ledger. Both agent providers (claude SDK + opencode) append one line per run
 * to `groups/<folder>/usage.jsonl` (host-persisted from the container's cwd) —
 * a single source that already spans providers and carries `total_cost_usd` and
 * `num_turns`. That makes it the right thing to read: no transcript scraping, no
 * per-provider store hunting, and it captures opencode/deepseek agents (Iris)
 * that the dashboard is blind to.
 *
 * Each line becomes one ledger row keyed `uj:<folder>:<lineIndex>`. The index is
 * stable for an append-only log, so re-scanning is idempotent under
 * INSERT OR IGNORE — no cursor/offset bookkeeping needed.
 */
import fs from 'node:fs';
import path from 'node:path';

import type Database from 'better-sqlite3';

import { GROUPS_DIR } from '../config.js';
import { getAllAgentGroups } from '../db/agent-groups.js';

export interface UsageEvent {
  eventId: string;
  agentGroupId: string;
  ts: string;
  day: string;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  numTurns: number | null;
  source: string;
}

interface UsageLine {
  ts?: string;
  model?: string | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  total_cost_usd?: number | null;
  num_turns?: number | null;
}

/** Coarse provider tag from the model slug (claude-* vs opencode/openrouter/*). */
function providerOf(model: string | null | undefined): string {
  if (!model) return 'unknown';
  return model.startsWith('claude') ? 'claude' : 'opencode';
}

/**
 * Parse one `usage.jsonl` line into a ledger event. `folder` + `lineIndex` form
 * the stable dedup key. Returns null for blank/unparseable/token-less lines.
 */
export function parseUsageLine(
  line: string,
  folder: string,
  agentGroupId: string,
  lineIndex: number,
): UsageEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let r: UsageLine;
  try {
    r = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const ts = r.ts;
  if (!ts) return null;
  const input = r.input_tokens || 0;
  const output = r.output_tokens || 0;
  const cacheRead = r.cache_read_input_tokens || 0;
  const cacheCreate = r.cache_creation_input_tokens || 0;
  const cost = typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null;
  if (input + output + cacheRead + cacheCreate === 0 && cost == null) return null;
  return {
    eventId: `uj:${folder}:${lineIndex}`,
    agentGroupId,
    ts,
    day: ts.slice(0, 10),
    provider: providerOf(r.model),
    model: r.model ?? null,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreate,
    costUsd: cost,
    numTurns: typeof r.num_turns === 'number' ? r.num_turns : null,
    source: 'usage-jsonl',
  };
}

function scanGroupUsage(folder: string, agentGroupId: string): UsageEvent[] {
  const file = path.join(GROUPS_DIR, folder, 'usage.jsonl');
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf-8');
  } catch {
    return []; // no usage.jsonl yet for this group
  }
  const events: UsageEvent[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ev = parseUsageLine(lines[i], folder, agentGroupId, i);
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * Scan every group's usage.jsonl and upsert events. Returns the number of NEW
 * rows inserted (existing event ids are ignored). Safe to call on an interval.
 */
export function collectUsage(db: Database.Database): { scanned: number; inserted: number } {
  const events: UsageEvent[] = [];
  for (const g of getAllAgentGroups()) {
    if (!g.folder) continue;
    events.push(...scanGroupUsage(g.folder, g.id));
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO usage_events
      (event_id, agent_group_id, ts, day, provider, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, num_turns, source)
    VALUES
      (@eventId, @agentGroupId, @ts, @day, @provider, @model,
       @inputTokens, @outputTokens, @cacheReadTokens, @cacheCreationTokens, @costUsd, @numTurns, @source)
  `);
  let inserted = 0;
  const insertAll = db.transaction((evs: UsageEvent[]) => {
    for (const e of evs) inserted += stmt.run(e).changes;
  });
  insertAll(events);

  return { scanned: events.length, inserted };
}
