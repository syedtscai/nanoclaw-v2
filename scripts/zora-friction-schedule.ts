/**
 * Register (or re-register) Zora's afternoon team-friction sweep.
 *
 * Usage:  pnpm exec tsx scripts/zora-friction-schedule.ts
 *
 * Inserts ONE recurring task into Zora's (agent-shared) inbound.db:
 *   - recurrence "0 15 * * *" — fires every day 15:00, evaluated in TIMEZONE
 *     (Asia/Singapore). This is the standalone afternoon friction pass; the
 *     morning pass is folded into Zora's existing 09:00 digest relay (free), so
 *     this is the second of the 2x/day friction sweeps.
 *   - NO pre-task gate. A task whose content carries no `script` passes through
 *     the container's applyPreTaskScripts() unchanged and always wakes the
 *     agent; Zora's routine then stays silent if there's nothing to escalate.
 *   - when woken, Zora runs the "judging Iris's friction candidates" routine
 *     from her playbook (CLAUDE.local.md): recall pending mnemon
 *     type:friction-candidate items, pull each Slack thread, judge, escalate to
 *     Mr. S only if warranted, and resolve candidates.
 *
 * Idempotent — and scope-SAFE: unlike Sage's dedicated inbound.db, Zora's carries
 * other traffic (chat-sdk rows, possibly other scheduled tasks). The cancel below
 * is scoped to the friction series ONLY (series_id LIKE 'task-zora-friction-%'),
 * so re-running this updates the friction schedule without touching anything else.
 *
 * Done host-side (not via Zora calling schedule_task) so the run prompt is
 * authored and reviewed in-repo rather than transcribed by the model.
 */
import path from 'node:path';
import { DATA_DIR, TIMEZONE } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, openInboundDb } from '../src/session-manager.js';
import { insertTask } from '../src/modules/scheduling/db.js';

const RECURRENCE = '0 15 * * *'; // Daily 15:00, evaluated in TIMEZONE

const PROMPT =
  'Scheduled team-dynamics friction sweep (afternoon ~15:00 SGT — NOT the morning digest run). ' +
  'Run the "judging Iris\'s friction candidates" routine from your instructions: recall pending mnemon ' +
  'type:friction-candidate / status:pending items, pull each full Slack thread live, judge escalate/FYI/ignore, ' +
  'and message Mr. S ONLY if there is something worth escalating or noting (otherwise send nothing — stay silent ' +
  'to save cost). Resolve every candidate (mnemon forget; store confirmed-real ones as durable type:friction ' +
  'insights). Do NOT produce a digest — friction-only.';

initDb(path.join(DATA_DIR, 'v2.db'));

const ag = getAgentGroupByFolder('dm-with-mr-s');
if (!ag) {
  console.error('Zora agent group (folder "dm-with-mr-s") not found.');
  process.exit(1);
}

const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const db = openInboundDb(ag.id, session.id);

// Idempotent + scope-safe: retire only the live friction task series, never
// touch chat-sdk rows or any other scheduled task in Zora's shared inbound.db.
const cancelled = db
  .prepare(
    "UPDATE messages_in SET status = 'completed', recurrence = NULL " +
      "WHERE kind = 'task' AND status IN ('pending', 'paused') " +
      "AND series_id LIKE 'task-zora-friction-%'",
  )
  .run();
if (cancelled.changes > 0) {
  console.log(`Retired ${cancelled.changes} existing live friction task row(s).`);
}

// First run = next cron occurrence in TIMEZONE; recurrence re-arms the rest.
const { CronExpressionParser } = await import('cron-parser');
const processAfter = CronExpressionParser.parse(RECURRENCE, { tz: TIMEZONE }).next().toISOString();

const id = `task-zora-friction-${Date.now()}`;
insertTask(db, {
  id,
  processAfter,
  recurrence: RECURRENCE,
  platformId: ag.id,
  channelType: 'agent',
  threadId: null,
  content: JSON.stringify({ prompt: PROMPT }),
});

console.log(
  `Registered Zora friction sweep schedule.\n` +
    `  task id:     ${id}\n` +
    `  session:     ${session.id}\n` +
    `  recurrence:  ${RECURRENCE}  (${TIMEZONE}: daily 15:00)\n` +
    `  first run:   ${processAfter}\n` +
    `  gate:        none — always wakes; stays silent if nothing to escalate.`,
);
db.close();
