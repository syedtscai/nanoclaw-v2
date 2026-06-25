/**
 * Focused DRY-RUN evaluation of Iris's KRISP transcript-attribution discipline.
 *
 * Usage:  pnpm exec tsx scripts/iris-krisp-eval.ts [<meeting-id-prefix>]
 *
 * Unlike scripts/iris-flash-eval.ts (full 3-day all-source sweep), this points
 * Iris at ONE specific Krisp meeting already sitting in her inbox and asks her
 * to produce the facts she WOULD file — writing NOTHING to mnemon and advancing
 * NO cursor/manifest. The point is to A/B a candidate model (flash vs pro) on the
 * single hardest fine-rule: NOT pinning a statement/decision to a named person on
 * the strength of the transcript's (or Krisp's pre-written notes') speaker labels.
 *
 * Run it once on the live model (flash) for a baseline, then flip Iris's group
 * model to pro (`ncl groups config update --id <iris> --model openrouter/deepseek/
 * deepseek-v4-pro-20260423`) and run again — compare the two report files.
 *
 * Default meeting = "T/Shern/Syed" transition meeting (019ef8fe…): heavily
 * pre-attributed, 3 participants but only 2 labelled speakers, sensitive
 * personnel content — the textbook mis-attribution trap.
 */
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';

const meetingPrefix = process.argv[2] || 'krisp-019ef8fe843f7322b34cbe5a0341696a';

initDb(path.join(DATA_DIR, 'v2.db'));
const ag = getAgentGroupByFolder('iris');
if (!ag) { console.error('Iris agent group not found.'); process.exit(1); }
const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const id = `iris-krisp-eval-${Date.now()}`;

const PROMPT = [
  'MODEL EVALUATION — STRICT DRY RUN of your KRISP transcript-attribution discipline. This is a one-off quality test, NOT a normal ingestion run.',
  '',
  'ABSOLUTE RULES (do not violate):',
  '- Make NO writes to mnemon: do NOT run mnemon_remember or mnemon_forget. (mnemon_recall IS allowed — read-only, needed for canonical entity resolution.)',
  '- Do NOT touch the manifest, any cursor, counts, or Gmail labels. Change NOTHING except writing the one report file named below.',
  '- This tests JUDGMENT, not dedup: even if a fact already exists in mnemon, STILL list what you WOULD file (you may note "(matches existing)").',
  '',
  `TARGET = the Krisp meeting whose files in /workspace/extra/ingest/inbox/ start with "${meetingPrefix}". Read BOTH its files if present (the note_generated AND the transcript_created/shared). Read the whole of each file, including the metadata header (Participants vs Labelled speakers) and the attribution banner.`,
  '',
  'Process it EXACTLY per your playbook "Source: Krisp" section — especially the MANDATORY attribution pre-write gate. Apply your normal triage, canonical entity resolution (recall freely), importance, and sensitivity tagging.',
  '',
  'OUTPUT — write ONE report to /workspace/agent/runs/KRISP-EVAL-<UTC-timestamp>.md:',
  '1. HEADER: meeting title, date, the Participants list vs the Labelled speakers list, and whether they mismatch (the high-risk tell).',
  '2. PROPOSED FACTS — a table, one row per fact you WOULD file: | content (verbatim as you would write it) | entities | tags (incl src/date/meeting/sensitivity/confidence) | imp | ATTRIBUTION-BASIS |.',
  '   - The ATTRIBUTION-BASIS column is the WHOLE POINT: for every fact, state how you decided the "who". One of: "meeting/group (no person named)", "named — corroborated by <the specific non-transcript signal>", or "named low-confidence (per transcript only)". If a fact names a person, you MUST justify it here or it is a gate violation.',
  '3. TRIAGED AS NOISE: items skipped, one-line reason each.',
  '4. SELF-AUDIT: list every fact in which you named a specific person, and confirm each one either has non-transcript corroboration or a confidence:low flag. Flag any that do not.',
  'End the report with a line confirming you wrote NOTHING to mnemon and advanced NO cursors.',
  '',
  'Reminder: DRY RUN. Recall freely (read-only). Write nothing but the report file.',
].join('\n');

writeSessionMessage(ag.id, session.id, {
  id, kind: 'chat', timestamp: new Date().toISOString(),
  platformId: ag.id, channelType: 'agent', threadId: null,
  content: JSON.stringify({ text: PROMPT, sender: 'system', senderId: 'system' }),
});
console.log(`Triggered Iris KRISP-attribution DRY-RUN eval — session ${session.id}, msg ${id}, target ${meetingPrefix}.`);
