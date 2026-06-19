/**
 * Usage monitor — observe-only phase.
 *
 * Periodically folds every agent's on-disk usage into the `usage_events`
 * ledger (see ./collect.ts). This phase only RECORDS; it does not yet enforce
 * tripwires or pause containers. The ledger it builds is the baseline source
 * for `scripts/usage-report.ts` and the future enforcement layer.
 *
 * Cadence is deliberately slower than the 60s host sweep — scanning transcripts
 * + opencode DBs is heavier and usage data is not latency-sensitive.
 */
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { collectUsage } from './collect.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | undefined;

function runOnce(): void {
  try {
    const { scanned, inserted } = collectUsage(getDb());
    if (inserted > 0) log.info('Usage monitor recorded events', { inserted, scanned });
  } catch (err) {
    log.warn('Usage monitor sweep failed', { err });
  }
}

export function startUsageMonitor(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (timer) return;
  runOnce(); // backfill immediately on boot
  timer = setInterval(runOnce, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('Usage monitor started', { intervalMs });
}

export function stopUsageMonitor(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
