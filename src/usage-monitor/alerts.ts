/**
 * Usage soft-alerts.
 *
 * When an agent's rolling-24h spend crosses its threshold, DM an admin/owner.
 * This is the SOFT tier only — it notifies, it never pauses or blocks a
 * container. A cooldown stops it re-DMing on every 5-min sweep while spend
 * stays elevated.
 *
 * Threshold per agent = its row in usage_alert_thresholds, else DEFAULT_DAILY_SOFT_USD.
 * "Spend" is the provider-reported total_cost_usd folded into usage_events; for
 * subscription-Claude agents that's notional API cost — a faithful proxy for the
 * load placed on the shared seat, which is the real ceiling.
 *
 * Decision (agentsNeedingAlert) is pure DB reads so it's unit-testable; the
 * effectful delivery lives in checkSoftAlerts.
 */
import type Database from 'better-sqlite3';

import { getDeliveryAdapter } from '../delivery.js';
import { getAllAgentGroups } from '../db/agent-groups.js';
import { log } from '../log.js';
import { pickApprover, pickApprovalDelivery } from '../modules/approvals/primitive.js';

/** Default rolling-24h soft cap (USD) for any agent without an explicit row. */
export const DEFAULT_DAILY_SOFT_USD = 20;
/** Don't re-DM about the same agent more often than this once it's over. */
export const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PendingAlert {
  agentGroupId: string;
  spend24h: number;
  threshold: number;
}

/**
 * Pure decision: which agents are over their threshold AND past the cooldown.
 * Reads usage_events + usage_alert_thresholds + usage_alert_state only.
 */
export function agentsNeedingAlert(
  db: Database.Database,
  nowMs: number,
  defaultUsd: number = DEFAULT_DAILY_SOFT_USD,
  cooldownMs: number = ALERT_COOLDOWN_MS,
): PendingAlert[] {
  const since = new Date(nowMs - WINDOW_MS).toISOString();
  const spend = db
    .prepare(
      `SELECT agent_group_id, COALESCE(SUM(cost_usd), 0) AS spend24h
         FROM usage_events
        WHERE ts >= ? AND cost_usd IS NOT NULL
        GROUP BY agent_group_id`,
    )
    .all(since) as { agent_group_id: string; spend24h: number }[];

  const thresholdFor = (id: string): number => {
    const row = db.prepare('SELECT daily_soft_usd FROM usage_alert_thresholds WHERE agent_group_id = ?').get(id) as
      | { daily_soft_usd: number }
      | undefined;
    return row ? row.daily_soft_usd : defaultUsd;
  };
  const lastAlertedMs = (id: string): number => {
    const row = db.prepare('SELECT last_alerted_at FROM usage_alert_state WHERE agent_group_id = ?').get(id) as
      | { last_alerted_at: string | null }
      | undefined;
    return row?.last_alerted_at ? Date.parse(row.last_alerted_at) : 0;
  };

  const out: PendingAlert[] = [];
  for (const r of spend) {
    const threshold = thresholdFor(r.agent_group_id);
    if (r.spend24h < threshold) continue;
    if (nowMs - lastAlertedMs(r.agent_group_id) < cooldownMs) continue;
    out.push({ agentGroupId: r.agent_group_id, spend24h: r.spend24h, threshold });
  }
  return out;
}

export function recordAlerted(db: Database.Database, agentGroupId: string, nowIso: string): void {
  db.prepare(
    `INSERT INTO usage_alert_state (agent_group_id, last_alerted_at)
     VALUES (?, ?)
     ON CONFLICT(agent_group_id) DO UPDATE SET last_alerted_at = excluded.last_alerted_at`,
  ).run(agentGroupId, nowIso);
}

function alertText(name: string, a: PendingAlert): string {
  return (
    `⚠️ Usage soft-alert — ${name}\n` +
    `~$${a.spend24h.toFixed(2)} in the last 24h (soft limit $${a.threshold.toFixed(0)}).\n` +
    `For subscription-Claude agents this is notional API cost — a proxy for seat load.\n` +
    `Alert only — nothing was paused. Tune the limit in usage_alert_thresholds.`
  );
}

/** Deliver a plain DM to the first reachable admin/owner for the agent. */
async function deliverOwnerAlert(agentGroupId: string, text: string): Promise<boolean> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return false; // adapter not ready yet (e.g. boot); next sweep retries
  const target = await pickApprovalDelivery(pickApprover(agentGroupId), '');
  if (!target) {
    log.warn('Usage alert: no reachable owner/admin to notify', { agentGroupId });
    return false;
  }
  await adapter.deliver(
    target.messagingGroup.channel_type,
    target.messagingGroup.platform_id,
    null,
    'chat',
    JSON.stringify({ text }),
  );
  return true;
}

/** Evaluate thresholds and DM owners for any agent newly over the line. */
export async function checkSoftAlerts(db: Database.Database): Promise<void> {
  const pending = agentsNeedingAlert(db, Date.now());
  if (pending.length === 0) return;
  const nameOf = new Map(getAllAgentGroups().map((g) => [g.id, g.name]));
  for (const a of pending) {
    const name = nameOf.get(a.agentGroupId) ?? a.agentGroupId;
    try {
      const sent = await deliverOwnerAlert(a.agentGroupId, alertText(name, a));
      if (sent) {
        recordAlerted(db, a.agentGroupId, new Date().toISOString());
        log.warn('Usage soft-alert sent', { agent: name, spend24h: a.spend24h, threshold: a.threshold });
      }
    } catch (err) {
      log.error('Usage soft-alert delivery failed', { agent: name, err });
    }
  }
}
