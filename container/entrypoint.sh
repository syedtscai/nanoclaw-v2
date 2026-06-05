#!/bin/bash
# NanoClaw agent container entrypoint.
#
# The host passes initial session parameters via stdin as a single JSON blob,
# then the agent-runner opens the session DBs at /workspace/{inbound,outbound}.db
# and enters its poll loop. All further IO flows through those DBs.
#
# We capture stdin to a file first so /tmp/input.json is available for
# post-mortem inspection if the container exits unexpectedly, then exec bun
# so that bun becomes PID 1's direct child (under tini) and receives signals.

set -e

# Run mnemon setup to register hooks and prompts, then patch the skill to allow
# direct Bash usage (no sub-agent delegation needed in the NanoClaw container).
mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1
SKILL_FILE="${HOME}/.claude/skills/mnemon/SKILL.md"
if [ -f "$SKILL_FILE" ]; then
  sed -i 's/Never run `remember` or `link` in the main conversation — always delegate to a sub-agent\./Run `remember` and `link` directly via Bash tool — no sub-agent needed in this environment./' "$SKILL_FILE" 2>/dev/null || true
fi

# Patch UserPromptSubmit hook to inject mnemon instructions via additionalContext
REMIND_HOOK="${HOME}/.claude/hooks/mnemon/user_prompt.sh"
if [ -f "$REMIND_HOOK" ]; then
  cat > "$REMIND_HOOK" << 'REMINDEOF'
#!/bin/bash
echo '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "[mnemon] REQUIRED this turn: (1) Run mnemon recall for the main topic BEFORE responding. (2) Run mnemon remember AFTER responding for any facts worth retaining (customer data, decisions, insights, preferences). Use Bash tool directly — no sub-agent needed."}}'
REMINDEOF
  chmod +x "$REMIND_HOOK"
fi

# Patch Stop hook (only supports systemMessage, not additionalContext)
STOP_HOOK="${HOME}/.claude/hooks/mnemon/stop.sh"
if [ -f "$STOP_HOOK" ]; then
  cat > "$STOP_HOOK" << 'STOPEOF'
#!/bin/bash
INPUT=$(cat)
MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null)
if echo "$MSG" | grep -qiE "mnemon remember|mnemon recall|action.*added|Stored.*imp="; then
  exit 0
fi
echo '{"systemMessage": "[mnemon] Tip: run mnemon recall/remember to persist facts from this turn."}'
STOPEOF
  chmod +x "$STOP_HOOK"
fi

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
