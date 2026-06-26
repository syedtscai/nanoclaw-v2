import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const moduleUsageAlerts: Migration = {
  version: 19,
  name: 'usage-alerts',
  up(db: Database.Database) {
    // Soft-alert layer for the usage monitor. Observe-and-notify only — when an
    // agent's rolling-24h spend crosses its threshold the host DMs an admin/owner;
    // nothing is ever paused (that's the deliberately-deferred hard tier).
    //
    //   usage_alert_thresholds — per-agent override of the default daily soft cap.
    //                            Absent row = fall back to the built-in default.
    //   usage_alert_state      — last time we alerted for an agent, so the cooldown
    //                            prevents re-DMing every sweep while spend stays high.
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_alert_thresholds (
        agent_group_id  TEXT PRIMARY KEY,
        daily_soft_usd  REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS usage_alert_state (
        agent_group_id  TEXT PRIMARY KEY,
        last_alerted_at TEXT
      );
    `);
  },
};
