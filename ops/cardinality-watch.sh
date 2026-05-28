#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC
#
# Phase 6 cardinality watch (ADR 0029, post-cutover-stabilization §8 Phase 6).
# Runs nightly inside the graphiti-sidecar container; appends the schema-
# registry diff to a host-side log so the Phase F STRICT_SCHEMA flip gate
# (7 consecutive nights of zero unregistered labels per app) can be checked
# without re-running the report.
#
# Host install (the server crontab — root):
#   0 4 * * * /srv/plexo/ops/cardinality-watch.sh
#
# Output:
#   /srv/plexo/data/cardinality-watch.log
#     One block per night, fenced by a "==> YYYY-MM-DDTHH:MM:SSZ" header.
#
# Exit code: always 0 unless docker exec itself fails — schema findings are
# data, not errors.

set -euo pipefail

CONTAINER="${CONTAINER:-service}"
LOG_DIR="${LOG_DIR:-/srv/plexo/data}"
LOG_FILE="${LOG_FILE:-${LOG_DIR}/cardinality-watch.log}"

mkdir -p "${LOG_DIR}"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
{
    echo "==> ${TS}"
    if ! docker exec "${CONTAINER}" python3 /app/scripts/cardinality_report.py 2>&1; then
        echo "ERROR: cardinality_report.py failed inside ${CONTAINER}"
    fi
    echo
} >> "${LOG_FILE}"
