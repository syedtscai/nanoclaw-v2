/**
 * Register (or re-register) Sage's monthly OPPORTUNITY-SCAN schedule.
 *
 * Usage:  pnpm exec tsx scripts/sage-opportunity-schedule.ts
 *
 * Inserts ONE recurring task into Sage's (agent-shared) inbound.db:
 *   - recurrence "0 8 3 * *" — fires on the 3rd of each month at 08:00,
 *     evaluated in TIMEZONE (Asia/Singapore). Spread away from the monthly
 *     wiki full refresh (1st, 02:00), the nightly backups (04:00/04:30), and
 *     the weekly Mon/Wed/Fri tasks' morning slots.
 *   - NO pre-task gate — a monthly upside pass is always worth running.
 *   - when woken, Sage runs "Task 5: Opportunity scan" per its playbook and
 *     sends one ranked digest to Zora.
 *
 * Idempotent + COLLISION-SAFE: cancels ONLY existing live *opportunity-scan*
 * task series (content contains "Opportunity-scan run"), never the
 * reconciliation / health / wiki / team-dynamics series — each registrar
 * scopes its own cancel likewise.
 *
 * Done host-side (not via schedule_task) so the run prompt is authored and
 * reviewed in-repo — shared with the manual trigger via
 * scripts/sage-opportunity-prompts.ts so the wording can't drift.
 */
import path from 'node:path';
import { DATA_DIR, TIMEZONE } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, openInboundDb } from '../src/session-manager.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { OPPORTUNITY_PROMPT } from './sage-opportunity-prompts.js';

const RECURRENCE = '0 8 3 * *'; // 3rd of the month, 08:00, evaluated in TIMEZONE

initDb(path.join(DATA_DIR, 'v2.db'));

const ag = getAgentGroupByFolder('sage');
if (!ag) {
  console.error('Sage agent group (folder "sage") not found.');
  process.exit(1);
}

const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const db = openInboundDb(ag.id, session.id);

const cancelled = db
  .prepare(
    "UPDATE messages_in SET status = 'completed', recurrence = NULL " +
      "WHERE kind = 'task' AND status IN ('pending', 'paused') AND content LIKE '%Opportunity-scan run%'",
  )
  .run();
if (cancelled.changes > 0) {
  console.log(`Retired ${cancelled.changes} existing live opportunity-scan task row(s).`);
}

const { CronExpressionParser } = await import('cron-parser');
const processAfter = CronExpressionParser.parse(RECURRENCE, { tz: TIMEZONE }).next().toISOString();

const id = `task-sage-opportunity-${Date.now()}`;
insertTask(db, {
  id,
  processAfter,
  recurrence: RECURRENCE,
  platformId: ag.id,
  channelType: 'agent',
  threadId: null,
  content: JSON.stringify({ prompt: OPPORTUNITY_PROMPT }),
});

console.log(
  `Registered Sage opportunity-scan schedule.\n` +
    `  task id:     ${id}\n` +
    `  session:     ${session.id}\n` +
    `  recurrence:  ${RECURRENCE}  (${TIMEZONE}: 3rd of month, 08:00)\n` +
    `  first run:   ${processAfter}\n` +
    `  gate:        none — monthly upside pass is always worth running.`,
);
