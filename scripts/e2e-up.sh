#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC
#
# e2e-up.sh — bring up the ephemeral E2E stack and wait until healthy.
# Pair with scripts/e2e-down.sh for teardown.
#
# Usage (preferred):
#   pnpm e2e:up
#
# Usage (direct):
#   bash scripts/e2e-up.sh
#
# Once up, the stack is reachable on the loopback interface:
#   web : http://127.0.0.1:3000
#   api : http://127.0.0.1:3001
# Run tests with `pnpm e2e:test`, tail logs with `pnpm e2e:logs`,
# tear down with `pnpm e2e:down`.
#
# Env vars:
#   COMPOSE_PROJECT_NAME   default plexo-e2e (override for parallel stacks)
#   COMPOSE_FILE           default docker-compose.e2e.yml
#   E2E_WAIT_SECONDS       default 240
#
# Exit codes:
#   0 — stack is up and healthchecks pass
#   1 — stack failed to start within E2E_WAIT_SECONDS

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.e2e.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-plexo-e2e}"
E2E_WAIT_SECONDS="${E2E_WAIT_SECONDS:-240}"

export COMPOSE_PROJECT_NAME

echo "==> bringing up E2E stack (project: $COMPOSE_PROJECT_NAME, file: $COMPOSE_FILE)"
docker compose -f "$COMPOSE_FILE" up -d --build --quiet-pull --wait --wait-timeout "$E2E_WAIT_SECONDS"

echo "==> probing api + web health endpoints"
deadline=$(( $(date +%s) + 60 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
    api_ok=""
    web_ok=""
    if curl -fsS --max-time 3 http://127.0.0.1:3001/health >/dev/null 2>&1; then
        api_ok=yes
    fi
    if curl -fsS --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/ 2>/dev/null | grep -qE '^(2|3)'; then
        web_ok=yes
    fi
    if [ -n "$api_ok" ] && [ -n "$web_ok" ]; then
        echo "==> stack ready (api + web responding)"
        exit 0
    fi
    sleep 2
done

echo "!! stack failed to respond on localhost:3000/3001 within 60s after compose-up"
docker compose -f "$COMPOSE_FILE" ps
docker compose -f "$COMPOSE_FILE" logs --no-color --tail 80
exit 1
