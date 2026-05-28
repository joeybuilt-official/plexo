#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC
#
# Phase C1 (ADR 0022) — daily permission-graph reconciliation runner.
# Copies the live scripts/reconcile-permission-graph.ts into the
# plexo-api container (which already has tsx + workspace packages
# resolved) and runs it. The 30-day clean clock is measured against the
# JSON-line log written here.
#
# Host install (the server — installed via /boot/config/go):
#   /etc/cron.d/permission-reconcile contains:
#     0 6 * * * root /srv/plexo/source/plexo/ops/permission-reconcile.sh
#
# Output:
#   /srv/plexo/data/permission-reconcile.log
#     One block per run (header + script JSON stdout).
#
# Exit code: passes through from the script (0 clean, 1 diff, 2 error).

set -uo pipefail

CONTAINER="${CONTAINER:-plexo-api}"
SRC_ROOT="${SRC_ROOT:-/srv/plexo/source/plexo}"
LOG_DIR="${LOG_DIR:-/srv/plexo/data}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/permission-reconcile.log}"
SCRIPT="scripts/reconcile-permission-graph.ts"

mkdir -p "${LOG_DIR}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT="$(mktemp)"
trap 'rm -f "${OUT}"' EXIT

if ! docker cp "${SRC_ROOT}/${SCRIPT}" "${CONTAINER}:/app/${SCRIPT}" 2>&1; then
    {
        echo "==> ${TS}"
        echo "ERROR: docker cp failed"
    } >> "${LOG_FILE}"
    exit 2
fi

docker exec \
    -e PLEXO_GRAPHITI_SIDECAR_URL="${PLEXO_GRAPHITI_SIDECAR_URL:-http://service:8080}" \
    "${CONTAINER}" \
    /app/node_modules/.bin/tsx "/app/${SCRIPT}" \
    > "${OUT}" 2>&1
RC=$?

{
    echo "==> ${TS} (rc=${RC})"
    cat "${OUT}"
    echo
} >> "${LOG_FILE}"

exit ${RC}
