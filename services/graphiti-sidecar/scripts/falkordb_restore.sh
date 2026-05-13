#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC
#
# Phase G FalkorDB restore drill (ADR 0030).
#
# This is a NON-DESTRUCTIVE drill. It does NOT touch the live falkordb
# container or volume. It:
#   1. Spins up a fresh FalkorDB container on port 16379 with a temporary
#      data directory.
#   2. Copies the supplied dump.rdb into that container's data dir.
#   3. Starts the container, waits for redis to come up.
#   4. Runs GRAPH.LIST and prints the discovered graph names (workspace
#      UUIDs). Optionally compares against an EXPECTED_WORKSPACES list
#      (newline-separated UUIDs in $EXPECTED_WORKSPACES_FILE).
#   5. Tears the drill container down on exit.
#
# A real restore (operator-run only) is documented in ops/README.md.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  cat <<USAGE >&2
Usage: falkordb_restore.sh <path-to-dump.rdb>

Optional env:
  RESTORE_PORT                  (default: 16379)
  RESTORE_CONTAINER             (default: service)
  RESTORE_IMAGE                 (default: falkordb/falkordb:v4.18.6)
  EXPECTED_WORKSPACES_FILE      newline-separated UUIDs to verify; pass-fail
USAGE
  exit 2
fi

BACKUP="$1"
PORT="${RESTORE_PORT:-16379}"
NAME="${RESTORE_CONTAINER:-service}"
IMAGE="${RESTORE_IMAGE:-falkordb/falkordb:v4.18.6}"
EXPECTED_FILE="${EXPECTED_WORKSPACES_FILE:-}"

if [[ ! -f "${BACKUP}" ]]; then
  echo "ERROR: backup file not found: ${BACKUP}" >&2
  exit 3
fi

log() { printf '[falkordb-restore %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

cleanup() {
  log "tearing down drill container ${NAME}"
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  if [[ -n "${TMPDIR_HOST:-}" && -d "${TMPDIR_HOST}" ]]; then
    rm -rf "${TMPDIR_HOST}"
  fi
}
trap cleanup EXIT

# Pre-clean any leftover drill container from a prior aborted run.
docker rm -f "${NAME}" >/dev/null 2>&1 || true

TMPDIR_HOST="$(mktemp -d -t falkordb-restore-XXXXXX)"
cp "${BACKUP}" "${TMPDIR_HOST}/dump.rdb"
chmod 644 "${TMPDIR_HOST}/dump.rdb"

log "starting drill container ${NAME} on port ${PORT}"
docker run -d \
  --name "${NAME}" \
  -p "${PORT}:6379" \
  -v "${TMPDIR_HOST}:/data" \
  "${IMAGE}" >/dev/null

# Wait for redis to load the rdb. Big dumps take a while; cap at 5 min.
DEADLINE=$(( $(date +%s) + 300 ))
while :; do
  if docker exec "${NAME}" redis-cli PING 2>/dev/null | grep -q PONG; then
    break
  fi
  if (( $(date +%s) > DEADLINE )); then
    log "ERROR: redis never came up inside ${NAME}"
    docker logs "${NAME}" | tail -50 >&2 || true
    exit 4
  fi
  sleep 2
done

log "container ready; listing graphs"
GRAPHS="$(docker exec "${NAME}" redis-cli GRAPH.LIST | tr -d '\r')"
if [[ -z "${GRAPHS}" ]]; then
  log "WARN: GRAPH.LIST returned empty — backup may be unloaded or empty"
fi

echo "---- workspace graphs in restored backup ----"
echo "${GRAPHS}"
echo "---------------------------------------------"

if [[ -n "${EXPECTED_FILE}" ]]; then
  if [[ ! -f "${EXPECTED_FILE}" ]]; then
    log "ERROR: EXPECTED_WORKSPACES_FILE not found: ${EXPECTED_FILE}"
    exit 5
  fi
  MISSING=0
  while IFS= read -r ws; do
    [[ -z "${ws}" ]] && continue
    if ! grep -qx "${ws}" <<<"${GRAPHS}"; then
      log "MISSING expected workspace graph: ${ws}"
      MISSING=$((MISSING + 1))
    fi
  done < "${EXPECTED_FILE}"
  if (( MISSING > 0 )); then
    log "FAIL: ${MISSING} expected workspaces missing from restored backup"
    exit 6
  fi
  log "PASS: all expected workspaces present"
fi

log "drill complete (container will be torn down on exit)"
