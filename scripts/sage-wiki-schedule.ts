/**
 * Register (or re-register) Sage's recurring WIKI maintenance schedules.
 *
 * Usage:  pnpm exec tsx scripts/sage-wiki-schedule.ts
 *
 * Inserts two recurring tasks into Sage's (agent-shared) inbound.db:
 *   - LINT  "0 8 * * 5"  — every Friday 08:00 (TIMEZONE = Asia/Singapore).
 *     Cheap read-only health check (staleness / orphans / gaps / missing refs).
 *   - FULL  "0 2 1 * *"  — 1st of each month 02:00. Heavy full re-ingest of all
 *     roster accounts + key people.
 *   Both slots dodge the existing schedule: mnemon-backup 04:00, restic 04:30,
 *   iris-prune 05:00, Sage reconciliation Mon 07:30, Iris ingest every 3h :00,
 *   Iris digest 09:00, Zora friction 15:00.
 *
 * Idempotent + COLLISION-SAFE: cancels only existing live *wiki* task series
 * (content begins "Wiki maintenance run"), so it never disturbs Sage's renewal-
 * reconciliation series (which scripts/sage-schedule.ts owns and scopes likewise).
 *
 * Done host-side (not via Sage calling schedule_task) so the run prompts are
 * authored and reviewed in-repo — shared with the manual trigger via
 * scripts/sage-wiki-prompts.ts so wording can't drift.
 */
import path from 'node:path';
import { DATA_DIR, TIMEZONE } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, openInboundDb } from '../src/session-manager.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { WIKI_ALL_PROMPT, WIKI_LINT_PROMPT } from './sage-wiki-prompts.js';

const SCHEDULES = [
  { label: 'lint (Fri 08:00)', recurrence: '0 8 * * 5', prompt: WIKI_LINT_PROMPT },
  { label: 'full refresh (1st 02:00)', recurrence: '0 2 1 * *', prompt: WIKI_ALL_PROMPT },
];

initDb(path.join(DATA_DIR, 'v2.db'));

const ag = getAgentGroupByFolder('sage');
if (!ag) {
  console.error('Sage agent group (folder "sage") not found.');
  process.exit(1);
}

const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const db = openInboundDb(ag.id, session.id);

// Idempotent + scoped: retire only existing live WIKI task series (never the
// reconciliation series). Matches the "Wiki maintenance run" prompt prefix.
const cancelled = db
  .prepare(
    "UPDATE messages_in SET status = 'completed', recurrence = NULL " +
      "WHERE kind = 'task' AND status IN ('pending', 'paused') AND content LIKE '%Wiki maintenance run%'",
  )
  .run();
if (cancelled.changes > 0) {
  console.log(`Retired ${cancelled.changes} existing live wiki task row(s).`);
}

const { CronExpressionParser } = await import('cron-parser');

for (const s of SCHEDULES) {
  const processAfter = CronExpressionParser.parse(s.recurrence, { tz: TIMEZONE }).next().toISOString();
  const id = `task-sage-wiki-${s.recurrence.replace(/[^0-9]/g, '')}-${Date.now()}`;
  insertTask(db, {
    id,
    processAfter,
    recurrence: s.recurrence,
    platformId: ag.id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ prompt: s.prompt }),
  });
  console.log(`Registered Sage wiki ${s.label}: ${s.recurrence} (${TIMEZONE}); first run ${processAfter}; id ${id}`);
}

db.close();
