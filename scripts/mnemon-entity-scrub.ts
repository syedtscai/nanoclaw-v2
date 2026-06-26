/**
 * mnemon entity-hygiene scrub — deterministic, recurring.
 *
 * Iris/Sage write `source:extraction` facts whose `entities` array sometimes
 * picks up junk: acronyms (AI, CRM, GRPA), generic terms, dollar amounts, or
 * name-fragments ("DP" beside "DP World"). Junk entities fragment the graph.
 * The hardened extraction prompt keeps this low (~12%) but not zero, so it
 * accumulates over time. This script mops it up on a schedule.
 *
 * It ONLY edits the `entities` field, and ONLY on `source:extraction` facts:
 *   - drops tokens on DENY (known junk),
 *   - maps known variants to canonical (VARIANT),
 *   - dedupes,
 *   - leaves content / tags / dates / id / edges / embedding untouched,
 *   - NEVER touches `source:user` facts (your blessed ground truth).
 *
 * Safety: refuses to run while any agent container is up (avoids concurrent
 * writes on the cross-mount WAL db), backs the db up first, and integrity-checks
 * before and after. Idempotent — a clean db is a no-op. Logs any short/acronym
 * tokens it did NOT recognise, as candidates to grow DENY over time.
 *
 * Usage:  pnpm exec tsx scripts/mnemon-entity-scrub.ts [--dry-run]
 * Scheduled via scripts/com.nanoclaw.mnemon-entity-scrub.plist (daily).
 */
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DRY = process.argv.includes('--dry-run');

// --- locate the live mnemon db (MNEMON_DATA_DIR from .env, ~ expanded) -------
function envValue(key: string): string | undefined {
  try {
    const env = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    const m = env.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}
const dataDirRaw = envValue('MNEMON_DATA_DIR') || '~/nanoclaw-memory/.mnemon';
const dataDir = dataDirRaw.replace(/^~/, os.homedir());
const DBP = path.join(dataDir, 'data', 'default', 'mnemon.db');

// --- hygiene rules -----------------------------------------------------------
// Map a non-canonical variant to its canonical entity (applied before DENY).
const VARIANT: Record<string, string> = {
  OCPN: 'OCP Nutricrops',
  AP: 'Access Partnership',
  DMS: 'DP World Delegation',
  'Delegation Management System': 'DP World Delegation',
  'Port Delegation': 'DP World Delegation',
  GRPA: 'DP World',
  'DP World GRPA': 'DP World',
  BRF: 'MBRF',
  AXIA: 'Axia',
  DPW: 'DP World',
  'Saudi Aramco RMA': 'Saudi Aramco',
};
// Drop these exactly (acronyms / generics / fragments / amounts). NOT real
// account/people/product names. Grow this list from the run log's "unrecognised
// tokens" section as new junk appears.
const DENY = new Set<string>([
  'AI','LLM','CS','BD','UAT','UI','UX','GR','IQ','BIG','ESUP','USD','DP','EU','CA','MENA','APAC','SCC',
  'SMA','VP','UPN','GCC','API','VAPT','ARR','KPI','ROI','POC','CRM','ETA','FYI','Q1','Q2','Q3','Q4','HQ',
  'PO','ZDR','NWA','UK','US','U.S','COP','MCP','PA','AACN','FFA','IFA','BCH','ESG','LATAM','GA','SRM','CI',
  'CVD','CSM','RSMD','QBR','OpEx','CapEx','NGO','GDPR','DRC','DH','ME','Next','VC','UPF','SSO','SQL','RISK',
  'QA','PS','PKF','OK','NTT','NSA','MM','MFA','ITC','IP','IETC','IA','HOLD','FX','FIN','FAQ','XM','LCS','OCP',
  'ISA','JO','SRM','SGT',
  // status / health / agent / role / format words that leaked into entities (from the scrub dry-run log)
  'YELLOW','RED','GREEN','SAGE','FLAG','GAP','STALE','DONE','CEO','CFO','HTML','DOCX','GPU','SLA','NDA','ACV',
  'MSA','KIV','DM','DS','BLT',
]);
// Known real short/all-caps entities — never flag as "unrecognised" in the log.
const KNOWN = new Set<string>([
  'TSC','JTI','SGS','TNB','OML','MBRF','TSAM','UNEP','Genie','AskGenie','RepSignal','APCO','Axia','OCP Global',
  'OCP Nutricrops','ISA Colombia','ISA Energia','Access Partnership','Workday','DP World','DP World Delegation',
  'JTI HQ','JTI JO','JTI NWA','JTI DRC','Bayer','Cindy',
]);

// --- guards ------------------------------------------------------------------
function agentContainersUp(): boolean {
  try {
    const out = execSync("docker ps --format '{{.Names}}'", { encoding: 'utf8' });
    return out.split('\n').some((n) => /^nanoclaw-v2-/.test(n.trim()));
  } catch {
    return false; // docker not reachable → assume safe (nothing running)
  }
}

function quickCheck(db: Database.Database): boolean {
  try {
    return (db.pragma('quick_check', { simple: true }) as string) === 'ok';
  } catch {
    return false;
  }
}

// --- run ---------------------------------------------------------------------
if (!fs.existsSync(DBP)) {
  console.error(`mnemon db not found at ${DBP}`);
  process.exit(1);
}
if (!DRY && agentContainersUp()) {
  console.log('[scrub] agent container(s) running — deferring to avoid concurrent writes. No-op.');
  process.exit(0);
}

if (!DRY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dataDir, 'backups', `mnemon-pre-scrub-${stamp}.db`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(DBP, backup);
  console.log(`[scrub] backup → ${backup}`);
}

const db = new Database(DBP);
if (!quickCheck(db)) {
  console.error('[scrub] integrity quick_check FAILED before scrub — aborting (let the watchdog recover).');
  process.exit(1);
}

const rows = db
  .prepare("SELECT id, entities FROM insights WHERE deleted_at IS NULL AND source = 'extraction'")
  .all() as Array<{ id: string; entities: string }>;

let changed = 0;
const unrecognised = new Map<string, number>();
const update = db.prepare('UPDATE insights SET entities = ? WHERE id = ?');
const tx = db.transaction(() => {
  for (const r of rows) {
    let ents: string[];
    try {
      ents = JSON.parse(r.entities);
      if (!Array.isArray(ents)) continue;
    } catch {
      continue;
    }
    const next: string[] = [];
    for (const e of ents) {
      const mapped = VARIANT[e] ?? e;
      if (DENY.has(mapped)) continue;
      // amounts/numbers are never entities (e.g. "3.9M", "193500", "18.5K", "50%")
      if (/^[\d.,]+\s*[%MmKkBbn]?$/.test(mapped)) continue;
      if (!next.includes(mapped)) next.push(mapped);
      // flag short/all-caps tokens we kept but don't recognise (deny-list candidates)
      if (!KNOWN.has(mapped) && !VARIANT[e] && (mapped.length <= 5 || mapped === mapped.toUpperCase())) {
        unrecognised.set(mapped, (unrecognised.get(mapped) ?? 0) + 1);
      }
    }
    if (JSON.stringify(next) !== r.entities) {
      changed++;
      if (!DRY) update.run(JSON.stringify(next), r.id);
    }
  }
});
tx();

if (!DRY && !quickCheck(db)) {
  console.error('[scrub] integrity quick_check FAILED AFTER scrub — restore the pre-scrub backup.');
  process.exit(1);
}
db.close();

const cands = [...unrecognised.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(
  `[scrub] ${DRY ? '(dry-run) ' : ''}scanned ${rows.length} extraction facts, ` +
    `${DRY ? 'would change' : 'changed'} ${changed}. integrity ok.`,
);
if (cands.length) {
  console.log('[scrub] unrecognised short/acronym tokens still present (deny-list candidates):');
  console.log('  ' + cands.map(([t, n]) => `${t}(${n})`).join('  '));
}
