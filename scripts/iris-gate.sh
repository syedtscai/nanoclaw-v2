# Iris pre-task gate — runs INSIDE the Iris container before the LLM, every time
# the 3-hourly ingestion task is due. Its job is to decide, cheaply and with NO
# LLM cost, whether it is worth waking Sonnet this tick.
#
# Wakes Sonnet (wakeAgent=true) when ANY of:
#   - it is the daily digest hour in Singapore time  → floor run: sweep Gmail
#     (which can't be cheaply pre-checked here) + send the consolidated digest.
#   - there are new files in the ingest inbox not yet in the manifest.
#   - there are new/updated Jira issues since the per-board cursor.
#   - there are new Slack messages since the cursor ts (one search.messages call).
# Otherwise wakeAgent=false → the task is marked completed, recurrence re-arms
# the next 3-hourly occurrence, and not a single token is spent.
#
# Contract: the LAST line of stdout MUST be JSON {"wakeAgent":bool,"data":{...}}.
# `data` is injected into Iris's prompt as "Script output" so she knows what
# changed and whether this is the digest run.
#
# Notes:
#   - Jira auth is injected transparently by the OneCLI gateway for
#     tsclabs.atlassian.net/rest/* — no token here, never put one here. Slack
#     auth is injected the same way for slack.com/api/* (user token; read-only).
#   - SGT (UTC+8, no DST) is computed arithmetically so we don't depend on
#     tzdata being present in the image.
#   - Resilient by design: a curl/gateway failure for a board (or for Slack)
#     counts as 0 new (logged to stderr) and never blocks the daily floor run.
#     Until the Slack OneCLI secret exists, the search call returns not_authed
#     → 0 new Slack → no behavior change (Slack stays dormant).
set -uo pipefail
shopt -s nullglob

WS=/workspace/agent
INBOX=/workspace/extra/ingest/inbox
MANIFEST="$WS/ingest-manifest.jsonl"
CURSORS="$WS/jira-cursor.json"
SLACK_CURSORS="$WS/slack-cursor.json"
SLACK_IGNORE="$WS/slack-ignore.txt"   # channels to mute (one bare name/id per line; # = comment)
DIGEST_HOUR_SGT=9          # Singapore-time hour for the daily consolidated digest + Gmail sweep

log() { echo "[iris-gate] $*" >&2; }

# --- Is this the daily digest run? (SGT = UTC + 8, no DST) ---
utc_h=$(date -u +%H)
sgt_h=$(( (10#$utc_h + 8) % 24 ))
DIGEST=false
[ "$sgt_h" -eq "$DIGEST_HOUR_SGT" ] && DIGEST=true

# --- New files in the inbox not yet recorded in the manifest (by basename) ---
NEW_FILES=0
for f in "$INBOX"/*; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  if [ -f "$MANIFEST" ] && grep -qF "$base" "$MANIFEST"; then
    continue
  fi
  NEW_FILES=$((NEW_FILES + 1))
done

# --- New Jira issues since the per-board cursor (one cheap count per board) ---
NEW_JIRA=0
jira_detail=()
board_filter() {
  # The high-signal slice for the GEN5 engineering firehose (board 256); the
  # other three boards ingest all updated issues. Mirrors the playbook JQL.
  case "$1" in
    256) printf '(labels in ("#product-issues", "#Renewal-Critical") OR priority in (High, Showstopper) OR issuetype = Epic) AND ' ;;
    *)   printf '' ;;
  esac
}
if [ -f "$CURSORS" ]; then
  for bid in 256 51 288 9; do
    cur=$(grep -o "\"$bid\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$CURSORS" | head -1 | sed -E 's/.*"([^"]*)"[[:space:]]*$/\1/')
    if [ -z "$cur" ]; then
      log "board $bid: no cursor yet — leaving to the daily floor run"
      continue
    fi
    # Jira JQL rejects ISO-8601 ("2026-06-06T19:53:21Z"). Convert to the
    # accepted "yyyy-MM-dd HH:mm"; fall back to date-only if the shape differs.
    if [[ "$cur" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}) ]]; then
      cur_jql="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}"
    else
      cur_jql="${cur%%T*}"
    fi
    jql="$(board_filter "$bid")updated >= \"$cur_jql\" ORDER BY updated ASC"
    resp=$(curl -s -G --max-time 20 "https://tsclabs.atlassian.net/rest/agile/1.0/board/$bid/issue" \
             --data-urlencode "jql=$jql" \
             --data-urlencode "fields=key" \
             --data-urlencode "maxResults=1" 2>/dev/null)
    if [ -z "$resp" ]; then
      log "board $bid: empty response (gateway/network?) — counting 0"
      continue
    fi
    total=$(printf '%s' "$resp" | grep -o '"total"[[:space:]]*:[[:space:]]*[0-9]\+' | head -1 | grep -o '[0-9]\+$')
    if [ -z "$total" ]; then
      log "board $bid: no total field (likely auth/error) — counting 0; resp=${resp:0:160}"
      continue
    fi
    if [ "$total" -gt 0 ]; then
      NEW_JIRA=$((NEW_JIRA + total))
      jira_detail+=("\"$bid\":$total")
    fi
  done
else
  log "no jira-cursor.json — leaving Jira to the daily floor run"
fi

# --- New Slack messages since the cursor ts (one cheap search.messages call) ---
# search.messages is Tier 2 (20+/min) and unaffected by the May-2025
# conversations.history throttle; a user token sees every channel + DM Mr. S is
# in. `after:` is day-granular, so we over-fetch the cursor's day and then keep
# only messages whose ts is strictly greater than last_ts (numeric compare).
# Over-counting only ever causes a harmless extra wake (Iris dedups by ts);
# under-counting is bounded by the daily floor run.
NEW_SLACK=0
if [ -f "$SLACK_CURSORS" ]; then
  s_last_ts=$(grep -o '"last_ts"[[:space:]]*:[[:space:]]*"[^"]*"' "$SLACK_CURSORS" | head -1 | sed -E 's/.*"([^"]*)"[[:space:]]*$/\1/')
  s_last_date=$(grep -o '"last_date"[[:space:]]*:[[:space:]]*"[^"]*"' "$SLACK_CURSORS" | head -1 | sed -E 's/.*"([^"]*)"[[:space:]]*$/\1/')
  if [ -z "$s_last_date" ]; then
    log "slack: no last_date in cursor — leaving Slack to the daily floor run"
  else
    # Honor the ignore-list so muted (noisy) channels don't trigger an empty
    # wake. Slack search supports `-in:<channel>` exclusions; build one per
    # non-comment line. (Iris also skips these during her sweep — this just
    # keeps the gate from waking her when the only new activity is muted.)
    s_ex=""
    if [ -f "$SLACK_IGNORE" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        line=$(printf '%s' "$line" | tr -d '[:space:]')   # channel names have no spaces
        [ -z "$line" ] && continue
        case "$line" in \#*) continue ;; esac              # comment line
        line="${line#\#}"                                  # defensive: drop a stray leading #
        [ -n "$line" ] && s_ex="$s_ex -in:$line"
      done < "$SLACK_IGNORE"
    fi
    s_resp=$(curl -s -G --max-time 20 'https://slack.com/api/search.messages' \
               --data-urlencode "query=after:$s_last_date$s_ex" \
               --data-urlencode 'sort=timestamp' \
               --data-urlencode 'sort_dir=desc' \
               --data-urlencode 'count=20' 2>/dev/null)
    if [ -z "$s_resp" ]; then
      log "slack: empty response (gateway/network?) — counting 0"
    elif printf '%s' "$s_resp" | grep -q '"ok"[[:space:]]*:[[:space:]]*false'; then
      # Most common while dormant: {"ok":false,"error":"not_authed"} (no secret yet).
      s_err=$(printf '%s' "$s_resp" | grep -o '"error"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1)
      log "slack: ok=false ($s_err) — counting 0 (secret not set / scope / auth)"
    else
      # Count message ts (NOT thread_ts — the regex anchors on the opening quote)
      # strictly newer than the cursor ts.
      NEW_SLACK=$(printf '%s' "$s_resp" \
        | grep -oE '"ts":"[0-9]+\.[0-9]+"' \
        | sed -E 's/"ts":"([0-9.]+)"/\1/' \
        | awk -v c="${s_last_ts:-0}" 'BEGIN{n=0} ($1+0)>(c+0){n++} END{print n}')
      [ -z "$NEW_SLACK" ] && NEW_SLACK=0
    fi
  fi
else
  log "no slack-cursor.json — leaving Slack to the daily floor run"
fi

# --- Decision ---
WAKE=false
if [ "$DIGEST" = "true" ] || [ "$NEW_FILES" -gt 0 ] || [ "$NEW_JIRA" -gt 0 ] || [ "$NEW_SLACK" -gt 0 ]; then
  WAKE=true
fi

jd=$(IFS=,; echo "${jira_detail[*]:-}")
log "decision: wake=$WAKE digest=$DIGEST sgt_h=$sgt_h new_files=$NEW_FILES new_jira=$NEW_JIRA new_slack=$NEW_SLACK"
printf '{"wakeAgent":%s,"data":{"digest":%s,"sgt_hour":%s,"new_files":%s,"new_jira":%s,"jira_by_board":{%s},"new_slack":%s}}\n' \
  "$WAKE" "$DIGEST" "$sgt_h" "$NEW_FILES" "$NEW_JIRA" "$jd" "$NEW_SLACK"
