#!/usr/bin/env bash
# Gate: block git push/force-push/merge/release and deploy commands unless PLEXO_DEPLOY_UNLOCK=1
# Claude Code PreToolUse hook — reads JSON from stdin.
# Output {"action":"block","message":"..."} to block the tool call.

set -uo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

if [[ -z "$COMMAND" ]]; then
    exit 0
fi

UNLOCKED="${PLEXO_DEPLOY_UNLOCK:-0}"

block() {
    echo "{\"action\":\"block\",\"message\":\"GATE: $1 Unlock: set PLEXO_DEPLOY_UNLOCK=1 in this session.\"}"
    exit 0
}

# ── git push (any form, including -f/--force and -C <dir> push) ───────────────
# Matches: git push, git -C /path push, git push -f, git push --force
if echo "$COMMAND" | grep -qE '(^|\s)git(\s+-C\s+\S+)?\s+push'; then
    [[ "$UNLOCKED" != "1" ]] && block "git push blocked (push was bypassed twice in prior harness sessions)."
fi

# ── gh pr merge ───────────────────────────────────────────────────────────────
if echo "$COMMAND" | grep -qE '(^|\s)gh\s+pr\s+merge'; then
    [[ "$UNLOCKED" != "1" ]] && block "gh pr merge blocked."
fi

# ── gh release (create/upload/publish) ───────────────────────────────────────
if echo "$COMMAND" | grep -qE '(^|\s)gh\s+release\s+(create|upload|publish)'; then
    [[ "$UNLOCKED" != "1" ]] && block "gh release blocked."
fi

# ── curl/wget deploy-via-webhook (Coolify, generic webhook deploy endpoints) ──
if echo "$COMMAND" | grep -qiE '(curl|wget).*(/deploy|/webhook|coolify|/api/v1/deploy)'; then
    [[ "$UNLOCKED" != "1" ]] && block "curl/webhook deploy blocked."
fi

# ── docker compose up (any container) ────────────────────────────────────────
if echo "$COMMAND" | grep -qE 'docker\s+compose.*\bup\b'; then
    [[ "$UNLOCKED" != "1" ]] && block "docker compose up blocked."
fi

# ── ssh <server> ... docker compose up/restart ───────────────────────────────────
if echo "$COMMAND" | grep -qE 'ssh.*hive.*docker.*compose.*(up|restart)'; then
    [[ "$UNLOCKED" != "1" ]] && block "remote deploy via ssh blocked."
fi

exit 0
