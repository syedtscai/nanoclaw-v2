import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { moduleUsageAlerts } from '../db/migrations/module-usage-alerts.js';
import { moduleUsageEvents } from '../db/migrations/module-usage-events.js';
import { agentsNeedingAlert, recordAlerted, ALERT_COOLDOWN_MS } from './alerts.js';

const NOW = Date.parse('2026-06-26T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3600_000).toISOString();

function addRun(db: Database.Database, agent: string, ts: string, cost: number): void {
  db.prepare(
    `INSERT INTO usage_events (event_id, agent_group_id, ts, day, provider, cost_usd, source)
     VALUES (?, ?, ?, ?, 'claude', ?, 'test')`,
  ).run(`${agent}:${ts}:${cost}`, agent, ts, ts.slice(0, 10), cost);
}

describe('agentsNeedingAlert', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    moduleUsageEvents.up(db);
    moduleUsageAlerts.up(db);
  });

  it('flags an agent over the default threshold and ignores one under', () => {
    addRun(db, 'sage', hoursAgo(2), 18);
    addRun(db, 'sage', hoursAgo(1), 14); // 32 in 24h → over default 20
    addRun(db, 'iris', hoursAgo(1), 3); // under
    const pending = agentsNeedingAlert(db, NOW, 20);
    expect(pending.map((p) => p.agentGroupId)).toEqual(['sage']);
    expect(pending[0].spend24h).toBeCloseTo(32);
  });

  it('respects a per-agent threshold override', () => {
    addRun(db, 'zora', hoursAgo(1), 22); // over default 20...
    db.prepare('INSERT INTO usage_alert_thresholds (agent_group_id, daily_soft_usd) VALUES (?, ?)').run('zora', 50);
    expect(agentsNeedingAlert(db, NOW, 20)).toEqual([]); // ...but under its $50 override
  });

  it('excludes spend older than the 24h window', () => {
    addRun(db, 'sage', hoursAgo(30), 100); // outside window
    addRun(db, 'sage', hoursAgo(1), 5); // inside, under threshold
    expect(agentsNeedingAlert(db, NOW, 20)).toEqual([]);
  });

  it('suppresses re-alerts within the cooldown, then re-fires after it', () => {
    addRun(db, 'sage', hoursAgo(1), 40);
    recordAlerted(db, 'sage', new Date(NOW - 1 * 3600_000).toISOString()); // alerted 1h ago
    expect(agentsNeedingAlert(db, NOW, 20)).toEqual([]); // within cooldown

    const past = NOW + ALERT_COOLDOWN_MS + 3600_000; // well after cooldown
    addRun(db, 'sage', new Date(past - 3600_000).toISOString(), 40); // keep 24h spend high
    expect(agentsNeedingAlert(db, past, 20).map((p) => p.agentGroupId)).toEqual(['sage']);
  });
});
