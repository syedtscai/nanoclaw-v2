/**
 * Register (or re-register) Sage's twice-daily TEAM-DYNAMICS (friction-judging) schedule.
 *
 * Usage:  pnpm exec tsx scripts/sage-friction-schedule.ts
 *
 * Inserts ONE recurring task into Sage's (agent-shared) inbound.db:
 *   - recurrence "0 9,15 * * *" — fires daily at 09:00 and 15:00, evaluated in
 *     TIMEZONE (Asia/Singapore). 09:00 lands just after Iris's daily digest run
 *     files the freshest candidates; 15:00 keeps worst-case lag on a daytime
 *     conflict at ~6h (same cadence the routine had on Zora).
 *   - NO pre-task gate — the run itself is cheap when there are no pending
 *     candidates (recall → nothing → silent log), and Sage stays silent to Zora
 *     on empty sweeps, so an empty tick costs one quiet wake and zero messages.
 *   - when woken, Sage runs "Task 4: Team-dynamics friction judging" per its
 *     playbook and messages Zora ONLY when something is worth escalating/noting.
 *
 * Idempotent + COLLISION-SAFE: cancels ONLY existing live *team-dynamics* task
 * series (content contains "Team-dynamics run"), never the reconciliation /
 * health / wiki series — each registrar scopes its own cancel likewise.
 *
 * Done host-side (not via schedule_task) so the run prompt is authored and
 * reviewed in-repo — shared with the manual trigger via
 * scripts/sage-friction-prompts.ts so the wording can't drift.
 *
 * NOTE: this schedule replaced Zora's 15:00 friction task (2026-07-08); the
 * one-time cancellation of Zora's task was done at migration time, not here.
 */
import path from 'node:path';
import { DATA_DIR, TIMEZONE } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, openInboundDb } from '../src/session-manager.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { FRICTION_PROMPT } from './sage-friction-prompts.js';

const RECURRENCE = '0 9,15 * * *'; // daily 09:00 + 15:00, evaluated in TIMEZONE

initDb(path.join(DATA_DIR, 'v2.db'));

const ag = getAgentGroupByFolder('sage');
if (!ag) {
  console.error('Sage agent group (folder "sage") not found.');
  process.exit(1);
}

const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const db = openInboundDb(ag.id, session.id);

// Idempotent + scoped: retire only existing live TEAM-DYNAMICS task series before
// inserting — never the reconciliation, health, or wiki series.
const cancelled = db
  .prepare(
    "UPDATE messages_in SET status = 'completed', recurrence = NULL " +
      "WHERE kind = 'task' AND status IN ('pending', 'paused') AND content LIKE '%Team-dynamics run%'",
  )
  .run();
if (cancelled.changes > 0) {
  console.log(`Retired ${cancelled.changes} existing live team-dynamics task row(s).`);
}

// First run = next cron occurrence in TIMEZONE; recurrence re-arms the rest.
const { CronExpressionParser } = await import('cron-parser');
const processAfter = CronExpressionParser.parse(RECURRENCE, { tz: TIMEZONE }).next().toISOString();

const id = `task-sage-friction-${Date.now()}`;
insertTask(db, {
  id,
  processAfter,
  recurrence: RECURRENCE,
  platformId: ag.id,
  channelType: 'agent',
  threadId: null,
  content: JSON.stringify({ prompt: FRICTION_PROMPT }),
});

console.log(
  `Registered Sage team-dynamics schedule.\n` +
    `  task id:     ${id}\n` +
    `  session:     ${session.id}\n` +
    `  recurrence:  ${RECURRENCE}  (${TIMEZONE}: daily 09:00 + 15:00)\n` +
    `  first run:   ${processAfter}\n` +
    `  gate:        none — empty sweeps are cheap and silent.`,
);
