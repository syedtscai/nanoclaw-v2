import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migration018 } from '../db/migrations/018-usage-events.js';

const FIXTURE_DIR = path.join(os.tmpdir(), 'nanoclaw-usage-test');

vi.mock('../config.js', () => ({ GROUPS_DIR: FIXTURE_DIR }));
vi.mock('../db/agent-groups.js', () => ({
  getAllAgentGroups: () => [{ id: 'ag-iris', name: 'Iris', folder: 'iris' }],
}));

// Imported after mocks are registered.
const { parseUsageLine, collectUsage } = await import('./collect.js');

const claudeLine = JSON.stringify({
  ts: '2026-06-19T07:01:20.638Z',
  model: 'claude-sonnet-4-6',
  input_tokens: 7,
  output_tokens: 1023,
  cache_creation_input_tokens: 40139,
  cache_read_input_tokens: 191236,
  total_cost_usd: 0.223,
  num_turns: 5,
});
const opencodeLine = JSON.stringify({
  ts: '2026-06-19T07:10:10.947Z',
  model: 'openrouter/deepseek/deepseek-v4-flash',
  input_tokens: 943225,
  output_tokens: 7280,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 505844,
  total_cost_usd: 0.0972,
  num_turns: 16,
});

describe('parseUsageLine', () => {
  it('parses a claude run and tags provider + stable dedup id', () => {
    const ev = parseUsageLine(claudeLine, 'dm', 'ag-z', 3)!;
    expect(ev.eventId).toBe('uj:dm:3');
    expect(ev.provider).toBe('claude');
    expect(ev.day).toBe('2026-06-19');
    expect(ev.costUsd).toBe(0.223);
    expect(ev.numTurns).toBe(5);
  });

  it('parses an opencode run and tags it opencode with real cost', () => {
    const ev = parseUsageLine(opencodeLine, 'iris', 'ag-iris', 0)!;
    expect(ev.provider).toBe('opencode');
    expect(ev.model).toBe('openrouter/deepseek/deepseek-v4-flash');
    expect(ev.costUsd).toBeCloseTo(0.0972);
    expect(ev.numTurns).toBe(16);
  });

  it('skips blank, unparseable, and token-less lines', () => {
    expect(parseUsageLine('', 'iris', 'ag-iris', 0)).toBeNull();
    expect(parseUsageLine('not json', 'iris', 'ag-iris', 0)).toBeNull();
    expect(parseUsageLine(JSON.stringify({ ts: 'x' }), 'iris', 'ag-iris', 0)).toBeNull();
  });
});

describe('collectUsage', () => {
  let db: Database.Database;

  beforeEach(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'iris'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE_DIR, 'iris', 'usage.jsonl'), opencodeLine + '\n' + claudeLine + '\n');
    db = new Database(':memory:');
    migration018.up(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('records each run once and is idempotent on re-scan', () => {
    const first = collectUsage(db);
    expect(first.inserted).toBe(2);

    // Re-scan with no new lines inserts nothing.
    const second = collectUsage(db);
    expect(second.inserted).toBe(0);

    // A newly appended line is picked up on the next scan.
    fs.appendFileSync(
      path.join(FIXTURE_DIR, 'iris', 'usage.jsonl'),
      JSON.stringify({
        ts: '2026-06-20T01:00:00Z',
        model: 'claude-sonnet-4-6',
        output_tokens: 50,
        total_cost_usd: 0.01,
        num_turns: 2,
      }) + '\n',
    );
    const third = collectUsage(db);
    expect(third.inserted).toBe(1);

    const total = db.prepare('SELECT COUNT(*) AS c FROM usage_events').get() as { c: number };
    expect(total.c).toBe(3);
    const byProvider = db
      .prepare('SELECT provider, COUNT(*) AS c FROM usage_events GROUP BY provider ORDER BY provider')
      .all();
    expect(byProvider).toEqual([
      { provider: 'claude', c: 2 },
      { provider: 'opencode', c: 1 },
    ]);
  });
});
