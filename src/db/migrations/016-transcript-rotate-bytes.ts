import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'transcript-rotate-bytes',
  up(db: Database.Database) {
    // Per-group override for the Claude transcript cold-resume rotation cap
    // (bytes). NULL = fall back to CLAUDE_TRANSCRIPT_ROTATE_BYTES / 12MB default.
    // Set low for stateless batch agents (e.g. Iris) so they start a fresh
    // session each run instead of re-reading an ever-growing transcript.
    db.prepare('ALTER TABLE container_configs ADD COLUMN transcript_rotate_bytes INTEGER').run();
  },
};
