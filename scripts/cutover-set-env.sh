#!/usr/bin/env bash
# cutover-set-env.sh — set/update an env var in the platform compose .env
# file and restart plexo-api so the change takes effect.
#
# Used by Phases 5, 6, 9 of operator-cutover-runbook.md (each flips an
# env var like MEMORY_WRITE_BACKEND or MEMORY_READ_BACKEND).
#
# Usage on the deploy host:
#   sudo PLEXO_COMPOSE_DIR=<your-infra-dir> ./scripts/cutover-set-env.sh KEY VALUE
#
# Examples:
#   sudo ./scripts/cutover-set-env.sh MEMORY_WRITE_BACKEND dual
#   sudo ./scripts/cutover-set-env.sh MEMORY_READ_BACKEND graphiti
#   sudo ./scripts/cutover-set-env.sh MEMORY_WRITE_BACKEND graphiti
#
# Idempotent: replaces the line if KEY already exists, appends if not.
# After the env file write, recreates plexo-api via compose so the new
# value is read on container start.
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "usage: $0 KEY VALUE" >&2
    exit 2
fi

KEY="$1"
VAL="$2"
COMPOSE_DIR="${PLEXO_COMPOSE_DIR:?set PLEXO_COMPOSE_DIR to the compose dir on this host}"
ENV_FILE="${COMPOSE_DIR}/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "FATAL: $ENV_FILE missing" >&2
    exit 3
fi

# Replace the existing KEY=... line (any value) or append if absent.
if grep -q "^${KEY}=" "$ENV_FILE"; then
    sed -i "s|^${KEY}=.*|${KEY}=${VAL}|" "$ENV_FILE"
    echo "updated: $KEY=$VAL"
else
    echo "${KEY}=${VAL}" >> "$ENV_FILE"
    echo "appended: $KEY=$VAL"
fi

cd "$COMPOSE_DIR"
docker compose --profile graphiti up -d --no-deps --no-build plexo-api

echo "waiting for plexo-api healthy…"
until [[ "$(docker inspect plexo-api --format '{{.State.Health.Status}}')" == healthy ]]; do
    sleep 5
done
echo "plexo-api healthy"
