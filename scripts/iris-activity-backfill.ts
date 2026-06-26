/**
 * One-time HISTORICAL backfill of per-account `type:activity` facts from Slack.
 *
 * Iris normally captures activities going forward only (from her live cursor). This
 * seeds the per-account engagement history Sage compiles, by sweeping a fixed
 * historical window for the customer-facing WORK TSC did for each account.
 *
 * Usage:
 *   pnpm exec tsx scripts/iris-activity-backfill.ts                       # PREVIEW (dry-run) on the default pilot pair
 *   pnpm exec tsx scripts/iris-activity-backfill.ts --accounts "DP World,UNEP"
 *   pnpm exec tsx scripts/iris-activity-backfill.ts --days 90
 *   pnpm exec tsx scripts/iris-activity-backfill.ts --accounts "DP World" --write   # REAL backfill (writes facts)
 *
 * SAFETY:
 *   - Default is PREVIEW: writes NOTHING to mnemon, touches NO cursor/manifest/label,
 *     emits a proposal report only. Add --write for the real pass.
 *   - ACCOUNT-SCOPED + ACTIVITY-ONLY: extracts only type:activity, never the full
 *     signal taxonomy (avoids duplicating/conflicting with forward-ingested facts).
 *   - NEVER touches slack-cursor.json (reads a fixed historical window) — so it can
 *     never create a gap or rewind normal forward ingestion.
 *   - --write mode is recall-first deduped + resumable (account-by-account); re-run
 *     with the remaining --accounts to continue if a wake hits the ceiling.
 */
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { resolveSession, writeSessionMessage } from '../src/session-manager.js';

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

const WRITE = flag('write');
const CLEAN = flag('clean-entities'); // entity-hygiene cleanup of facts already written
const DAYS = Number(val('days') ?? 90);
const accountsArg = val('accounts') ?? 'DP World,UNEP'; // pilot pair: one busy + one quieter
const accounts = accountsArg.split(',').map((a) => a.trim()).filter(Boolean);

// Pre-compute the window start so the model never does date arithmetic.
const sinceDate = new Date(Date.now() - DAYS * 864e5).toISOString().slice(0, 10);

// ---- prompt ----------------------------------------------------------------
const accountList = accounts.map((a) => `"${a}"`).join(', ');

const COMMON = [
  `WINDOW: only messages dated on/after ${sinceDate} (last ${DAYS} days). Use Slack search modifier after:${sinceDate}.`,
  `ACCOUNTS (process ONE at a time, in order): ${accountList}.`,
  '',
  'SCOPE — where to look, per account:',
  `- Its dedicated channel if one exists ( in:#account-<slug> ), AND`,
  `- A name search across the high-signal channels: search.messages query="\\"<account name>\\" after:${sinceDate}" and also scan the Tier-1 channels (cs-meet, delivery-and-revenue-leads, account-management, bd, projectmgmt) for that account.`,
  '- Pull thread context (conversations.replies) when a message references a piece of work. Resolve channel/user ids to names. Read-only ALWAYS (search.messages/conversations.*/users.info only — never any chat.*/write).',
  `- ⚠️ COVERAGE (critical — cover the ENTIRE window per channel, no silent gaps): search.messages → paginate forward (page=1,2,3,…) until results predate ${sinceDate} or pages are exhausted. conversations.history → pass oldest=<epoch seconds of ${sinceDate}> AND PAGINATE via response_metadata.next_cursor while has_more=true — NEVER stop at the first 200 messages (that silently drops the most recent months, as happened to Saudi Aramco's June in the preview). If despite paginating you still cannot reach the full window, state the EXACT uncovered date range in the output — never imply full coverage you didn't achieve.`,
  '',
  'WHAT TO EXTRACT — type:activity ONLY (per your playbook "Account activities / work done"):',
  '- A discrete unit of customer-facing WORK TSC performed or is performing for the account: demo/presentation given, meeting/call held, deliverable shipped, report/analysis delivered, feature/fix deployed for the account, proposal/pricing sent, onboarding/training run, data ingested, POC/pilot milestone, support/escalation handled.',
  '- One atomic, dated item per activity. NOT intentions ("we should…"), NOT internal process chatter, NOT the customer\'s own state (that is type:status). Do NOT extract risk/renewal/decision/friction facts here — this pass is activity-only.',
  '- Resolve the account + any person to canonical mnemon names (recall freely — read-only). Attribute WHO did it only when the message makes it clear; if it comes from a meeting transcript, apply the Meeting-notes attribution gate.',
  '- ⚠️ ENTITY HYGIENE (HARD RULE — do not slip on this under volume): `entities` = ONLY canonical proper nouns — real people (full canonical name), the account/company, and named products/projects (e.g. "Genie", "RepSignal"). Typically just **[account] + the one person who did it = 2 entities; 3 max.** NEVER put in entities: acronyms or abbreviations (AI, LLM, CS, BD, UI, UX, UAT, DP, EU, CA, MENA, APAC, GCC, VP, ESUP, GR, IQ, USD, BIG, SMA, UPN…), generic terms, dollar amounts, or a fragment of a name (a partner firm like "GR-IQ" is ONE entity written in full — never split into "GR"+"IQ"; "DP World" is the entity — never also add "DP"). All that context belongs in the CONTENT, not entities. Junk entities fragment the graph — this is the #1 thing to get right. ACCOUNT MODEL: "DP World" (main GRPA account; "GRPA"/"DP World GRPA" map to it) is DISTINCT from "DP World Delegation" (the DMS upsell/sub-account; "DMS"/"Delegation Management System"/"Port Delegation" map to it). Attribute Delegation/DMS/UAT/website work to "DP World Delegation"; core GRPA/Media-Relations work to "DP World". Never collapse one into the other; "DMS" is NOT junk — it is the sub-account.',
  '- DM/mpdm/private-channel sourced → sensitivity:high.',
].join('\n');

const PREVIEW_PROMPT = [
  'HISTORICAL ACTIVITY BACKFILL — STRICT DRY RUN (PREVIEW). One-off quality/volume test, NOT a normal run.',
  '',
  'ABSOLUTE RULES (do not violate):',
  '- Make NO writes to mnemon: NO mnemon_remember, NO mnemon_forget. (mnemon_recall IS allowed — read-only, for canonical resolution + dedup checks.)',
  '- Touch NO cursor (NEVER read or write slack-cursor.json for this), NO manifest, NO counts, NO labels. Change NOTHING except the one report file named below.',
  '- This tests JUDGMENT + VOLUME: even if an activity already exists in mnemon, STILL list it and mark "(matches existing)".',
  '',
  COMMON,
  '',
  'OUTPUT — write ONE report to /workspace/agent/runs/ACTIVITY-BACKFILL-PREVIEW-<UTC-timestamp>.md:',
  '- A section per account. For each: a table of PROPOSED activity facts — | date | content (verbatim as you would write it) | entities (canonical) | function | source (channel) | (matches existing?) |.',
  '- Per account: a count of proposed activities + how many messages/threads you scanned (for volume/cost estimation) + note any search truncation (no silent caps).',
  '- A "skipped / not an activity" one-line sample per account (so I can see the noise bar).',
  'End the report confirming you wrote NOTHING to mnemon, touched NO cursor/manifest/labels.',
  '',
  'DRY RUN. Recall freely (read-only). Write nothing but the report file.',
].join('\n');

const WRITE_PROMPT = [
  `HISTORICAL ACTIVITY BACKFILL — REAL WRITE PASS. Account-scoped, activity-only, last ${DAYS} days. Resumable.`,
  '',
  COMMON,
  '',
  'WRITE RULES:',
  '- For each genuine activity, RECALL FIRST to dedup (`mnemon_recall "<account> activity <gist>"`); skip if already filed. Then mnemon_remember with cat "context", imp 2 (3 only if a genuinely notable milestone), source "extraction", canonical entities, tags type:activity,src:slack,account:<canonical>,date:<when it was done>,function:<CS|Tech|BD|Product>[,channel:<name>][,sensitivity:high]. APPEND (activities are events — never supersede).',
  '- ⚠️ DO NOT touch slack-cursor.json — this is a historical pass independent of forward ingestion. Do not advance or rewind any cursor.',
  '- Finish one account completely before the next. If you approach the run ceiling, STOP cleanly and write the run log noting which accounts are DONE and which remain (I will re-trigger with the remaining --accounts).',
  '',
  'Write this run\'s log to /workspace/agent/runs/ACTIVITY-BACKFILL-<UTC-timestamp>.md: per account, how many activities filed + scanned, dedup skips, any truncation, and the DONE/REMAINING account list. Send NOTHING to Zora (silent — this is a backfill).',
].join('\n');

const CLEAN_PROMPT = [
  'ENTITY-HYGIENE CLEANUP of existing type:activity facts. This is NOT ingestion — NO Slack, NO search, NO re-extraction, NO new facts. You ONLY fix the entities array on facts that already exist.',
  '',
  'INPUT: read /workspace/agent/runs/entity-cleanup-targets.json — a JSON array of existing facts, each {id, content, category, importance, source, tags, entities}.',
  '',
  'FOR EACH fact in the file:',
  '1. Evaluate its current entities against the HARD hygiene rule (below).',
  '2. If ALL its entities are already canonical proper nouns → LEAVE IT UNTOUCHED (do nothing).',
  '3. If ANY entity is junk → mnemon_forget by the EXACT id from the file (never a recalled id of another fact), then mnemon_remember with the SAME content, SAME category (as cat), SAME importance (as imp), SAME source, SAME tags, and CLEANED entities. Change ONLY the entities array — preserve content/tags/cat/imp/source byte-for-byte.',
  '',
  'HARD hygiene rule — entities = ONLY canonical proper nouns: real people (full canonical name), the account/company, and named products/projects (e.g. "Genie", "RepSignal", "AskGenie"). Typically [account] + the one person = 2; 3 max.',
  'JUNK to REMOVE: acronyms/abbreviations (AI, LLM, CS, BD, UI, UX, UAT, DP, EU, CA, MENA, APAC, GCC, VP, ESUP, GR, IQ, USD, BIG, SMA, UPN, SCC, API, VAPT, ARR, etc.), generic terms, dollar amounts, and name-fragments. Resolve variants to canonical (recall to confirm): "DP" beside "DP World" → drop "DP"; a partner firm "GR-IQ" is ONE entity in full, never "GR"+"IQ". When unsure whether a token is a real product/company vs an acronym, recall it — if no canonical entity exists, drop it.',
  'ACCOUNT-MODEL MAPPINGS (do NOT drop these — MAP them): "DMS" / "Delegation Management System" / "Port Delegation" → "DP World Delegation" (a DISTINCT sub-account, keep it); "GRPA" / "DP World GRPA" → "DP World". Never collapse "DP World Delegation" into "DP World" — they are two different accounts.',
  '',
  'Forget strictly by the exact id in the file. mnemon writes occasionally fail transiently — retry a couple of times. Process every fact in the file.',
  '',
  'OUTPUT: write a run log to /workspace/agent/runs/ENTITY-CLEANUP-<UTC-timestamp>.md: scanned N, cleaned M (with ~8 before→after entity examples), left-already-clean K. Send NOTHING to Zora (silent).',
].join('\n');

// ---- dispatch --------------------------------------------------------------
initDb(path.join(DATA_DIR, 'v2.db'));
const ag = getAgentGroupByFolder('iris');
if (!ag) { console.error('Iris agent group not found.'); process.exit(1); }
const { session } = resolveSession(ag.id, null, null, 'agent-shared');
const mode = CLEAN ? 'clean' : WRITE ? 'write' : 'preview';
const promptText = CLEAN ? CLEAN_PROMPT : WRITE ? WRITE_PROMPT : PREVIEW_PROMPT;
const id = `iris-activity-backfill-${mode}-${Date.now()}`;

writeSessionMessage(ag.id, session.id, {
  id, kind: 'chat', timestamp: new Date().toISOString(),
  platformId: ag.id, channelType: 'agent', threadId: null,
  content: JSON.stringify({ text: promptText, sender: 'system', senderId: 'system' }),
});

console.log(
  CLEAN
    ? `Triggered Iris activity-backfill ENTITY CLEANUP — reads runs/entity-cleanup-targets.json, session ${session.id}, msg ${id}.`
    : `Triggered Iris activity-backfill ${WRITE ? 'REAL WRITE' : 'PREVIEW (dry-run)'} — ` +
        `accounts [${accounts.join(', ')}], since ${sinceDate} (${DAYS}d), session ${session.id}, msg ${id}.`,
);
