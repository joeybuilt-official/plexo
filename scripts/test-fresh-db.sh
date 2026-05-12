#!/usr/bin/env bash
# Phase J fresh-DB stand-up smoke test.
# Spins a disposable postgres:16 container, runs every migration end-to-end,
# fails on any WARNING or "skipped" line in migrate output.
#
# Usage:
#   bash scripts/test-fresh-db.sh
#
# Exits 0 on clean migrate; non-zero otherwise.

set -euo pipefail

CONTAINER=plexo-fresh-db-smoke-$$
PORT=$((20000 + RANDOM % 20000))
PASSWORD=phasej-$(date +%s)
MIGRATE_OUT=$(mktemp /tmp/plexo-fresh-migrate.XXXXXX.log)

cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -f "$MIGRATE_OUT"
}
trap cleanup EXIT

echo "[fresh-db] Starting postgres:16 as $CONTAINER on :$PORT"
docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD="$PASSWORD" \
    -e POSTGRES_USER=plexo \
    -e POSTGRES_DB=plexo \
    -p "$PORT:5432" \
    pgvector/pgvector:pg16 >/dev/null

echo "[fresh-db] Waiting for postgres readiness…"
for i in {1..30}; do
    if docker exec "$CONTAINER" pg_isready -U plexo -d plexo >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if ! docker exec "$CONTAINER" pg_isready -U plexo -d plexo >/dev/null 2>&1; then
    echo "[fresh-db] postgres did not become ready in 30s"
    exit 1
fi

export DATABASE_URL="postgresql://plexo:$PASSWORD@localhost:$PORT/plexo"
echo "[fresh-db] DATABASE_URL=postgresql://plexo:***@localhost:$PORT/plexo"

# Better Auth and many migrations expect pgcrypto / vector extensions; mirror
# what the prod docker-compose initdb does.
docker exec "$CONTAINER" psql -U plexo -d plexo -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null

cd "$(dirname "$0")/.."
echo "[fresh-db] Running migrations…"
if ! pnpm --filter @plexo/db exec tsx src/migrate.ts > "$MIGRATE_OUT" 2>&1; then
    echo "[fresh-db] FAIL: migrate.ts exited non-zero"
    cat "$MIGRATE_OUT"
    exit 1
fi

# Phase J exit invariant: zero warnings, zero "skipped" lines.
if grep -E "(WARNING|skipped)" "$MIGRATE_OUT" > /dev/null; then
    echo "[fresh-db] FAIL: migrate output contains warnings or skipped lines"
    grep -E "(WARNING|skipped)" "$MIGRATE_OUT"
    exit 1
fi

echo "[fresh-db] PASS — fresh DB stood up clean with no warnings"
echo "[fresh-db] migrate output:"
tail -20 "$MIGRATE_OUT"
