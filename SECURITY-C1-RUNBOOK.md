# C1 Runbook — Egress Lockdown + Credentials to Vault

**Scheduled window: Saturday 2026-07-11 (Zora sends a Telegram reminder at 09:30 SGT).**
To execute: open Claude Code in this repo and say **"run the C1 runbook"**.

C1 is the last outstanding CRITICAL from the 2026-06-27 audit
(`SECURITY-AUDIT-2026-06-26.md`): open container egress + the Anthropic OAuth
token sitting in container env means one successful prompt injection can
exfiltrate the token off-box. Fix = (a) egress lockdown so containers can only
reach the OneCLI gateway, (b) move `CLAUDE_CODE_OAUTH_TOKEN` into the OneCLI
vault so no credential lives in container env, (c) block the cloud metadata IP.

**Estimated duration: 1–2 h. Agents will restart during the window. Do NOT run
unattended — spawns are fail-closed under lockdown (a wiring mistake stops all
agents until fixed).**

## Constraints already known (do not rediscover)

1. **`NANOCLAW_EGRESS_LOCKDOWN` is read from `process.env` ONLY, not `.env`**
   (`src/egress-lockdown.ts`). It must be added to the launchd plist
   `~/Library/LaunchAgents/com.nanoclaw-v2-9772a425.plist` under
   `EnvironmentVariables` (currently only HOME+PATH) followed by
   `launchctl kickstart -k gui/$(id -u)/com.nanoclaw-v2-9772a425`.
2. **Fail-closed:** with the flag set, every container spawn THROWS unless the
   `nanoclaw-egress` internal docker network exists **with the OneCLI gateway
   container attached**. Create + attach BEFORE flipping the flag.
3. **Subscription-auth conflict (the hard part).** Zora/Sage/Iris currently
   authenticate to Anthropic via `CLAUDE_CODE_OAUTH_TOKEN` in container env
   with a `NO_PROXY=api.anthropic.com` DIRECT bypass
   (`src/container-runner.ts`, "Claude subscription auth" block; see the
   claude-subscription-auth memory — 3 fixes, commit d7a48bb). Under lockdown
   there is no direct path — so C1(b) must land first: token into the vault,
   gateway injects the Bearer for `api.anthropic.com`, and
   `NANOCLAW_NATIVE_CREDENTIALS` turned off so the NO_PROXY bypass + env token
   stop being emitted. **If the OneCLI gateway cannot inject an OAuth Bearer
   for Anthropic correctly, C1 CANNOT ship without breaking subscription auth
   — that is the abort condition to test for FIRST.**
4. **GUARDRAIL (standing, from Mr. S): never test auth-path changes on
   Zora/prod agents.** Use a throwaway agent group for every auth experiment.
5. **mnemon daemon (added 2026-07-08):** agents reach it at
   `http://host.docker.internal:8377`, which is unreachable from an internal
   network. Required change: attach `nanoclaw-mnemon-daemon-9772a425` to the
   egress network and, when lockdown is enabled, have
   `MNEMON_DAEMON_CONTAINER_URL` (src/mnemon-daemon.ts) resolve to
   `http://nanoclaw-mnemon-daemon-9772a425:8377` instead (and skip the
   host.docker.internal NO_PROXY entry). Small code change + tests.
6. Host-side things are unaffected (they have host network): Telegram
   delivery, the run-watchdog, backups, recall eval, `iris-gate.sh`.

## Plan

0. **Checkpoint:** confirm last night's mnemon + restic backups succeeded;
   `git status` clean; note current `onecli agents list` output.
1. **Throwaway group:** create agent group `c1-test` (`ncl groups create`),
   wire nothing — trigger via `scripts/` message injection or a CLI session.
2. **C1(b) on the throwaway:** put `CLAUDE_CODE_OAUTH_TOKEN` into the OneCLI
   vault scoped to `api.anthropic.com` (Bearer injection); spawn c1-test WITHOUT
   native credentials and verify a real model call succeeds via the gateway
   (check gateway logs for the injected auth; expect the ANTHROPIC_API_KEY
   placeholder pitfall from the subscription-auth memory). **Abort here if
   Bearer injection can't be made to work — file findings, revert, reschedule.**
3. **mnemon daemon network change:** code edit per constraint 5 + typecheck +
   tests; rebuild NOT needed (host-side only) unless entrypoint touched.
4. **Create network + attach:** `docker network create --internal
   nanoclaw-egress` (exact name expected by egress-lockdown.ts — verify in
   code); `docker network connect nanoclaw-egress <onecli-gateway-container>`
   and same for the mnemon daemon.
5. **Flip:** disable `NANOCLAW_NATIVE_CREDENTIALS` in `.env`; add
   `NANOCLAW_EGRESS_LOCKDOWN` to the plist; `launchctl kickstart -k`.
6. **Verify on throwaway first, then prod:** spawn c1-test → model call OK,
   mnemon_recall OK, a gateway-injected API (Jira/Slack) OK, and a direct
   `curl https://example.com` FAILS (that's the point). Then wake Iris
   manually (`scripts/iris-trigger.ts`) and watch a full ingestion run. Block
   `169.254.169.254` (gateway rule or network config) and verify.
7. **Cleanup:** delete c1-test group; update `SECURITY-AUDIT-2026-06-26.md` +
   the security-audit memory (C1 → CLOSED); commit + push.

## Rollback (any step)

Remove `NANOCLAW_EGRESS_LOCKDOWN` from the plist, restore
`NANOCLAW_NATIVE_CREDENTIALS=true` in `.env`, `launchctl kickstart -k`,
verify a Zora Telegram round-trip. The vault token entry can stay (harmless
when native credentials are back on).
