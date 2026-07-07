#!/bin/bash
# run-watchdog.sh — dead-man's switch for the agent pipelines.
#
# The failure mode this covers: a wedged cron, dead host service, or crashed
# container produces *silence* that is indistinguishable from a quiet day —
# Iris's daily digest only proves "Iris ran", never "Iris didn't run".
# This script is the host-side observer that notices missing runs and alerts
# Mr. S's Telegram DM directly via the Bot API (NOT through nanoclaw or any
# agent — it must work precisely when they don't).
#
# Checks:
#   1. nanoclaw host service is loaded in launchd
#   2. Iris produced a run log within the last 27h (daily 09:00-SGT digest is
#      the guaranteed floor even when the 3h gate skips every tick)
#   3. Sage produced a run log within the last 8 days (Mon/Wed/Fri crons)
#
# Anti-spam: each failing check alerts at most once per 12h (state file).
# Recovery: when a previously-failing check passes again, sends one all-clear.
#
# Deliberately dependency-free (bash + curl + stat): must run when Node/pnpm
# or the repo itself is broken. Installed via launchd (hourly):
#   ~/Library/LaunchAgents/com.nanoclaw.run-watchdog.plist
# Reference copy of the plist lives at scripts/com.nanoclaw.run-watchdog.plist.
# Manual test: bash scripts/run-watchdog.sh --test  (sends one test message)

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/logs/run-watchdog.log"
STATE="$ROOT/logs/run-watchdog.state"
SERVICE_LABEL="com.nanoclaw-v2-9772a425"
CHAT_ID="1000361138"
IRIS_MAX_AGE_H=27
SAGE_MAX_AGE_H=192   # 8 days
REALERT_H=12

mkdir -p "$ROOT/logs"
touch "$STATE"

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $1" >> "$LOG"; }

# Read TELEGRAM_BOT_TOKEN from .env without sourcing the whole file.
BOT_TOKEN="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")"
if [ -z "$BOT_TOKEN" ]; then
  log "FATAL: TELEGRAM_BOT_TOKEN not found in $ROOT/.env — cannot alert"
  exit 1
fi

send_telegram() {
  # $1 = message text. Returns curl's exit status; logs API failures.
  local resp
  resp="$(curl -sS --max-time 30 "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${CHAT_ID}" \
    --data-urlencode "text=$1" 2>&1)"
  if echo "$resp" | grep -q '"ok":true'; then
    log "alert sent: $(echo "$1" | head -1)"
    return 0
  fi
  log "ERROR sending telegram alert: $resp"
  return 1
}

# State file: lines of "<check>=<last_alert_epoch>" for currently-FAILING checks.
state_get() { grep -m1 "^$1=" "$STATE" 2>/dev/null | cut -d= -f2; }
state_set() {
  local tmp="$STATE.tmp"
  grep -v "^$1=" "$STATE" > "$tmp" 2>/dev/null || true
  echo "$1=$2" >> "$tmp"
  mv "$tmp" "$STATE"
}
state_clear() {
  local tmp="$STATE.tmp"
  grep -v "^$1=" "$STATE" > "$tmp" 2>/dev/null || true
  mv "$tmp" "$STATE"
}

NOW="$(date +%s)"

newest_mtime() {
  # $1 = dir. Prints epoch mtime of newest regular file, or 0 if none.
  local newest
  newest="$(find "$1" -type f -maxdepth 1 2>/dev/null -exec stat -f '%m' {} + | sort -rn | head -1)"
  echo "${newest:-0}"
}

# fail <check-id> <human message> / pass <check-id> <recovery message>
fail_check() {
  local id="$1" msg="$2" last
  last="$(state_get "$id")"
  if [ -z "$last" ] || [ $((NOW - last)) -ge $((REALERT_H * 3600)) ]; then
    send_telegram "🚨 nanoclaw watchdog: $msg" && state_set "$id" "$NOW"
  else
    log "still failing (suppressed, alerted $(( (NOW - last) / 60 ))m ago): $id"
  fi
}
pass_check() {
  local id="$1" msg="$2"
  if [ -n "$(state_get "$id")" ]; then
    send_telegram "✅ nanoclaw watchdog: $msg"
    state_clear "$id"
  fi
}

if [ "${1:-}" = "--test" ]; then
  send_telegram "✅ run-watchdog installed — test message. Hourly checks: nanoclaw service, Iris runs (<${IRIS_MAX_AGE_H}h), Sage runs (<8d)."
  exit $?
fi

# --- Check 1: host service loaded ---
if launchctl list "$SERVICE_LABEL" >/dev/null 2>&1; then
  pass_check svc "nanoclaw host service is back (${SERVICE_LABEL})."
else
  fail_check svc "nanoclaw host service NOT loaded (${SERVICE_LABEL}). All agents are down. Fix: launchctl load ~/Library/LaunchAgents/${SERVICE_LABEL}.plist"
fi

# --- Check 2: Iris run recency ---
IRIS_M="$(newest_mtime "$ROOT/groups/iris/runs")"
IRIS_AGE_H=$(( (NOW - IRIS_M) / 3600 ))
if [ "$IRIS_M" -eq 0 ] || [ "$IRIS_AGE_H" -ge "$IRIS_MAX_AGE_H" ]; then
  fail_check iris "no Iris run log in ${IRIS_AGE_H}h (threshold ${IRIS_MAX_AGE_H}h). Ingestion may be dead — check logs/nanoclaw.error.log and the 3h task in Iris's inbound.db."
else
  pass_check iris "Iris is running again (last run ${IRIS_AGE_H}h ago)."
fi

# --- Check 3: Sage run recency ---
SAGE_M="$(newest_mtime "$ROOT/groups/sage/runs")"
SAGE_AGE_H=$(( (NOW - SAGE_M) / 3600 ))
if [ "$SAGE_M" -eq 0 ] || [ "$SAGE_AGE_H" -ge "$SAGE_MAX_AGE_H" ]; then
  fail_check sage "no Sage run log in $((SAGE_AGE_H / 24))d (threshold 8d). Weekly synthesis may be dead — check Sage's scheduled tasks."
else
  pass_check sage "Sage is running again (last run $((SAGE_AGE_H / 24))d ago)."
fi

log "sweep ok: svc=$(launchctl list "$SERVICE_LABEL" >/dev/null 2>&1 && echo up || echo DOWN) iris_age=${IRIS_AGE_H}h sage_age=${SAGE_AGE_H}h"
