/**
 * One-off DRY-RUN evaluation trigger for Iris (model A/B, e.g. DeepSeek flash vs pro).
 *
 * Usage:  pnpm exec tsx scripts/iris-flash-eval.ts
 *
 * Drops a strict DRY-RUN message into Iris's agent-shared session: she processes
 * the last 3 days across ALL sources and reports the facts she WOULD file — but
 * writes NOTHING to mnemon and advances NO cursor. Lets us compare a candidate
 * model's extraction/triage judgment against the live (pro) baseline with zero
 * risk to the real graph or the live pipeline. Flip OPENCODE_MODEL to the
 * candidate before running; flip back after.
 */
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';

initDb(path.join(DATA_DIR, 'v2.db'));
const ag = getAgentGroupByFolder('iris');
if (!ag) { console.error('Iris agent group not found.'); process.exit(1); }
const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const id = `iris-flash-eval-${Date.now()}`;

const PROMPT = [
  'MODEL EVALUATION — STRICT DRY RUN. This is a one-off test of your extraction/triage quality. It is NOT a normal ingestion run.',
  '',
  'ABSOLUTE RULES (do not violate):',
  '- Make NO writes to mnemon: do NOT run `mnemon remember` or `mnemon forget`. (`mnemon recall` IS allowed — read-only, needed for entity resolution/watchlist.)',
  '- Do NOT modify or advance ANY cursor file (slack-cursor.json, jira-cursor.json, hubspot-cursor.json). Do NOT add Gmail `Iris-Processed` labels. Do NOT touch the manifest or counts. Change NOTHING except writing the one report file named below.',
  '- This tests JUDGMENT, not dedup: even if a similar fact already exists in mnemon, STILL list what you WOULD file. You may append "(matches existing)" but always include it as a proposed extraction. Do not suppress proposals just because the graph already has them.',
  '',
  'WINDOW = the LAST 3 DAYS (since 2026-06-12), across ALL sources — IGNORE the saved cursors for this eval and use the date window instead:',
  '- Slack: search.messages with `after:2026-06-12` (sort=timestamp); honor the ignore-list; normal triage.',
  '- Jira: the 4 boards with their normal per-board JQL but `updated >= "2026-06-12"`.',
  '- HubSpot: TSC New Deals pipeline (pipeline=default), deals with hs_lastmodifieddate within the last 3 days.',
  '- Gmail: the labelled mail is already Iris-Processed, so read `label:Iris-Processed newer_than:3d` and triage those.',
  '- Inbox: any files present.',
  '',
  'For EACH source apply your NORMAL triage exactly per your playbook: watchlist relevance, signal vs noise, canonical entity resolution, importance 1-5, sensitivity tagging, CRM-hygiene calibration for HubSpot.',
  '',
  'OUTPUT — write ONE report to /workspace/agent/runs/FLASH-EVAL-<UTC-timestamp>.md, organised per source:',
  '- PROPOSED FACTS: a table — | would-file content | --entities | --tags (incl src/date/channel/board/stage/sensitivity) | --imp |. These are proposals; you are NOT filing them.',
  '- TRIAGED AS NOISE: items you would skip, each with a one-line reason.',
  '- COUNTS: items seen / would-file / skipped, per source.',
  'End the report with a line confirming you wrote NOTHING to mnemon and advanced NO cursors.',
  '',
  'Reminder: DRY RUN. Recall freely (read-only). Write nothing but the report file.',
].join('\n');

writeSessionMessage(ag.id, session.id, {
  id, kind: 'chat', timestamp: new Date().toISOString(),
  platformId: ag.id, channelType: 'agent', threadId: null,
  content: JSON.stringify({ text: PROMPT, sender: 'system', senderId: 'system' }),
});
console.log(`Triggered Iris DRY-RUN eval — session ${session.id}, msg ${id}.`);
