#!/usr/bin/env bash
# Gate: block git push and deploy commands unless PLEXO_DEPLOY_UNLOCK=1
# Claude Code PreToolUse hook — reads JSON from stdin.
# Output {"action":"block","message":"..."} to block the tool call.

set -uo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

if [[ -z "$COMMAND" ]]; then
    exit 0
fi

UNLOCKED="${PLEXO_DEPLOY_UNLOCK:-0}"

# Block git push (any form)
if echo "$COMMAND" | grep -qE '^\s*git\s+push'; then
    if [[ "$UNLOCKED" != "1" ]]; then
        echo '{"action":"block","message":"GATE: git push blocked. Set PLEXO_DEPLOY_UNLOCK=1 in this session to unlock. This gate exists because push was bypassed twice during harness sessions."}'
        exit 0
    fi
fi

# Block docker compose up (any container — deploy = up)
if echo "$COMMAND" | grep -qE 'docker\s+compose.*\bup\b'; then
    if [[ "$UNLOCKED" != "1" ]]; then
        echo '{"action":"block","message":"GATE: docker compose up blocked. Set PLEXO_DEPLOY_UNLOCK=1 in this session to unlock."}'
        exit 0
    fi
fi

# Block ssh <server> ... docker compose up/restart
if echo "$COMMAND" | grep -qE 'ssh.*hive.*docker.*compose.*(up|restart)'; then
    if [[ "$UNLOCKED" != "1" ]]; then
        echo '{"action":"block","message":"GATE: remote deploy via ssh blocked. Set PLEXO_DEPLOY_UNLOCK=1 to unlock."}'
        exit 0
    fi
fi

exit 0
