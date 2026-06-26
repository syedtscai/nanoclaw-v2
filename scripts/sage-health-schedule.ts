/**
 * Register (or re-register) Sage's weekly ACCOUNT-HEALTH schedule.
 *
 * Usage:  pnpm exec tsx scripts/sage-health-schedule.ts
 *
 * Inserts ONE recurring task into Sage's (agent-shared) inbound.db:
 *   - recurrence "30 7 * * 3" — fires every Wednesday 07:30, evaluated in TIMEZONE
 *     (Asia/Singapore). Off-aligned from Iris's :00 runs + 09:00 digest, and spread
 *     onto a different day from Sage's Monday reconciliation + Friday wiki lint so the
 *     shared team-seat load isn't all stacked on one morning.
 *   - NO pre-task gate — a weekly health read is always worth running; a task whose
 *     content carries no `script` passes applyPreTaskScripts() unchanged and always wakes.
 *   - when woken, Sage runs "Task 3: Account-health synthesis" per its playbook and
 *     sends a consolidated health digest to Zora.
 *
 * Idempotent + COLLISION-SAFE: cancels ONLY existing live *account-health* task series
 * (content begins "Account-health run"), so it never disturbs the renewal-reconciliation
 * series (scripts/sage-schedule.ts) or the wiki series (scripts/sage-wiki-schedule.ts) —
 * each registrar scopes its own cancel likewise.
 *
 * Done host-side (not via Sage calling schedule_task) so the run prompt is authored and
 * reviewed in-repo — shared with the manual trigger via scripts/sage-health-prompts.ts
 * so the wording can't drift.
 */
import path from 'node:path';
import { DATA_DIR, TIMEZONE } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, openInboundDb } from '../src/session-manager.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { HEALTH_PROMPT } from './sage-health-prompts.js';

const RECURRENCE = '30 7 * * 3'; // Wednesdays 07:30, evaluated in TIMEZONE

initDb(path.join(DATA_DIR, 'v2.db'));

const ag = getAgentGroupByFolder('sage');
if (!ag) {
  console.error('Sage agent group (folder "sage") not found.');
  process.exit(1);
}

const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const db = openInboundDb(ag.id, session.id);

// Idempotent + scoped: retire only existing live ACCOUNT-HEALTH task series before
// inserting — never the reconciliation or wiki series. Matches the prompt prefix
// ("Account-health run.").
const cancelled = db
  .prepare(
    "UPDATE messages_in SET status = 'completed', recurrence = NULL " +
      "WHERE kind = 'task' AND status IN ('pending', 'paused') AND content LIKE '%Account-health run%'",
  )
  .run();
if (cancelled.changes > 0) {
  console.log(`Retired ${cancelled.changes} existing live account-health task row(s).`);
}

// First run = next cron occurrence in TIMEZONE; recurrence re-arms the rest.
const { CronExpressionParser } = await import('cron-parser');
const processAfter = CronExpressionParser.parse(RECURRENCE, { tz: TIMEZONE }).next().toISOString();

const id = `task-sage-health-${Date.now()}`;
insertTask(db, {
  id,
  processAfter,
  recurrence: RECURRENCE,
  platformId: ag.id,
  channelType: 'agent',
  threadId: null,
  content: JSON.stringify({ prompt: HEALTH_PROMPT }),
});

console.log(
  `Registered Sage account-health schedule.\n` +
    `  task id:     ${id}\n` +
    `  session:     ${session.id}\n` +
    `  recurrence:  ${RECURRENCE}  (${TIMEZONE}: Wednesdays 07:30)\n` +
    `  first run:   ${processAfter}\n` +
    `  gate:        none — always runs (weekly health read is always worth it).`,
);
db.close();
