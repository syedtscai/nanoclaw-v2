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

# Run mnemon setup to register hooks and prompts, then patch the skill to steer
# usage to the mnemon_* MCP TOOLS (never the Bash CLI): the tools pass fact
# content as structured argv with no shell (untrusted text stays inert), and in
# single-writer daemon mode (MNEMON_DAEMON_URL) the shared DB is only reachable
# through them — a Bash `mnemon` call would hit an empty local store.
mnemon setup --target claude-code --yes --global >/dev/stderr 2>&1
SKILL_FILE="${HOME}/.claude/skills/mnemon/SKILL.md"
if [ -f "$SKILL_FILE" ]; then
  sed -i 's/Never run `remember` or `link` in the main conversation — always delegate to a sub-agent\./Use the mnemon_* MCP tools (mnemon_remember, mnemon_recall, mnemon_forget, mnemon_run) for ALL mnemon operations — never the Bash `mnemon` CLI, and no sub-agent needed./' "$SKILL_FILE" 2>/dev/null || true
fi

# Patch UserPromptSubmit hook to inject mnemon instructions via additionalContext
REMIND_HOOK="${HOME}/.claude/hooks/mnemon/user_prompt.sh"
if [ -f "$REMIND_HOOK" ]; then
  cat > "$REMIND_HOOK" << 'REMINDEOF'
#!/bin/bash
echo '{"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "[mnemon] REQUIRED this turn: (1) Use the mnemon_recall MCP tool for the main topic BEFORE responding. (2) Use the mnemon_remember MCP tool AFTER responding for any facts worth retaining (customer data, decisions, insights, preferences). Always the mnemon_* MCP tools — NEVER the Bash mnemon CLI."}}'
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
echo '{"systemMessage": "[mnemon] Tip: use the mnemon_recall/mnemon_remember MCP tools to persist facts from this turn."}'
STOPEOF
  chmod +x "$STOP_HOOK"
fi

cat > /tmp/input.json

exec bun run /app/src/index.ts < /tmp/input.json
