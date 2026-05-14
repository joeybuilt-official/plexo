#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Joeybuilt LLC
#
# e2e-down.sh — tear down the ephemeral E2E stack and purge all volumes.
# Pair with scripts/e2e-up.sh.
#
# Usage (preferred):
#   pnpm e2e:down
#
# Usage (direct):
#   bash scripts/e2e-down.sh

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.e2e.yml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-plexo-e2e}"

export COMPOSE_PROJECT_NAME

echo "==> tearing down E2E stack (project: $COMPOSE_PROJECT_NAME)"
docker compose -f "$COMPOSE_FILE" down --volumes --remove-orphans --timeout 15 || true

echo "==> done"
