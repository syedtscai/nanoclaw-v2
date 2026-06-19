import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'usage-events',
  up(db: Database.Database) {
    // Durable, cross-provider usage ledger. One row per agent RUN, fed from the
    // unified `groups/<folder>/usage.jsonl` that BOTH providers (claude +
    // opencode) append a line to per run. Keyed by a STABLE event id
    // (`uj:<folder>:<lineIndex>`, stable for an append-only log) so the
    // collector can re-scan idempotently (INSERT OR IGNORE).
    //
    // This is the queryable substrate the flat per-group logs are not: a single
    // store across all agents, indexed by day, ready for rolling-window spend
    // queries and the future tripwire-enforcement layer.
    //
    //   cost_usd  — total_cost_usd as reported by the provider (now populated
    //               for opencode/OpenRouter too); NULL only if absent.
    //   num_turns — internal turns in the run; the per-call runaway signal that
    //               informs a maxTurns ceiling.
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        event_id               TEXT PRIMARY KEY,
        agent_group_id         TEXT NOT NULL,
        ts                     TEXT NOT NULL,
        day                    TEXT NOT NULL,
        provider               TEXT NOT NULL,
        model                  TEXT,
        input_tokens           INTEGER NOT NULL DEFAULT 0,
        output_tokens          INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_usd               REAL,
        num_turns              INTEGER,
        source                 TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_usage_events_group_day ON usage_events(agent_group_id, day);
      CREATE INDEX IF NOT EXISTS idx_usage_events_day ON usage_events(day);
    `);
  },
};
