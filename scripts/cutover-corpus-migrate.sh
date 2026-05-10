#!/usr/bin/env bash
# cutover-corpus-migrate.sh — wrapper for Phase 7 of operator-cutover-runbook.md.
#
# Runs migrate-corpus-to-graphiti.ts inside the plexo_internal docker
# network so it can reach postgres + the graphiti sidecar (both are
# compose-internal, no host-port exposure).
#
# Usage on the joeybuilt VPS (REDACTED_VPS_IP):
#   cd /srv/plexo
#   ./scripts/cutover-corpus-migrate.sh <workspace-id> [--dry-run|--resume] [--batch=N]
#
# Examples:
#   ./scripts/cutover-corpus-migrate.sh 69d1f1f1-...  --dry-run
#   ./scripts/cutover-corpus-migrate.sh 69d1f1f1-...  --batch=10
#   ./scripts/cutover-corpus-migrate.sh 69d1f1f1-...  --resume --batch=20
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: $0 <workspace-id> [--dry-run|--resume] [--batch=N] [--delay-ms=N]" >&2
    exit 2
fi

WORKSPACE_ID="$1"
shift
EXTRA_ARGS=("$@")

PLEXO_KEY="$(docker inspect plexo-api --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep '^PLEXO_SERVICE_KEY=' | cut -d= -f2-)"
DB_URL="$(docker inspect plexo-api --format '{{range .Config.Env}}{{println .}}{{end}}' \
    | grep '^DATABASE_URL=' | cut -d= -f2-)"

if [[ -z "$PLEXO_KEY" || -z "$DB_URL" ]]; then
    echo "FATAL: could not extract PLEXO_SERVICE_KEY or DATABASE_URL from plexo-api container env" >&2
    exit 3
fi

docker run --rm --network plexo_internal \
    -v /srv/plexo:/app -w /app \
    -e WORKSPACE_ID="$WORKSPACE_ID" \
    -e PLEXO_SERVICE_KEY="$PLEXO_KEY" \
    -e PLEXO_GRAPHITI_SIDECAR_URL=http://service:8080 \
    -e DATABASE_URL="$DB_URL" \
    node:22 ./node_modules/.bin/tsx scripts/migrate-corpus-to-graphiti.ts "${EXTRA_ARGS[@]}"
