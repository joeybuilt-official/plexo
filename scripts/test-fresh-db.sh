#!/usr/bin/env bash
# Phase J fresh-DB stand-up smoke test.
# Spins a disposable postgres:16 container, runs the FULL migration chain
# end-to-end — journaled drizzle migrations PLUS the un-journaled hand-SQL
# orphans (0130+) — then asserts that columns/tables/indexes introduced by the
# orphan range actually exist.
#
# Why the orphan step and the column assertions are load-bearing:
# migrations 0130-0143 are hand-written SQL deliberately kept OUT of
# meta/_journal.json (they were applied by hand in prod), so drizzle-kit will
# NEVER replay them. A fresh install that only runs `db:migrate` comes up with
# a silently incomplete schema — missing columns the app writes to at runtime.
# CI (.github/workflows/ci.yml) runs `db:migrate` then `db:apply-orphaned`;
# docker-compose.yml sets APPLY_ORPHANED_SQL=1 on the migrate service. This
# script mirrors that chain and fails loudly if any of it regresses.
#
# Usage:
#   bash scripts/test-fresh-db.sh
#
# Exits 0 on clean migrate + complete schema; non-zero otherwise.

set -euo pipefail

CONTAINER=plexo-fresh-db-smoke-$$
PORT=$((20000 + RANDOM % 20000))
PASSWORD=phasej-$(date +%s)
MIGRATE_OUT=$(mktemp /tmp/plexo-fresh-migrate.XXXXXX.log)
ORPHAN_OUT=$(mktemp /tmp/plexo-fresh-orphan.XXXXXX.log)

cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    rm -f "$MIGRATE_OUT" "$ORPHAN_OUT"
}
trap cleanup EXIT

echo "[fresh-db] Starting postgres:16 as $CONTAINER on :$PORT"
docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD="***" \
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

export DATABASE_URL="postgresql://plexo:***@localhost:$PORT/plexo"
echo "[fresh-db] DATABASE_URL points at localhost:$PORT (password redacted in logs)"

# Better Auth and many migrations expect pgcrypto / vector extensions; mirror
# what the prod docker-compose initdb does.
docker exec "$CONTAINER" psql -U plexo -d plexo -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null

cd "$(dirname "$0")/.."
echo "[fresh-db] Running journaled migrations (db:migrate)…"
if ! pnpm --filter @plexo/db exec tsx src/migrate.ts > "$MIGRATE_OUT" 2>&1; then
    echo "[fresh-db] FAIL: migrate.ts exited non-zero"
    cat "$MIGRATE_OUT"
    exit 1
fi

# migrate.ts intentionally warns when SQL files exist on disk that the journal
# does not reference — that is the orphan range we are about to apply, so that
# specific warning is expected. Anything ELSE warning, or any "skipped" line,
# is a real failure.
unexpected=$(grep -E "(WARNING|skipped)" "$MIGRATE_OUT" \
    | grep -v "NOT in _journal.json" \
    | grep -v "Drizzle will skip these silently" || true)
if [ -n "$unexpected" ]; then
    echo "[fresh-db] FAIL: migrate output contains unexpected warnings or skipped lines"
    echo "$unexpected"
    exit 1
fi

echo "[fresh-db] Applying un-journaled orphan SQL 0130+ (db:apply-orphaned)…"
if ! pnpm --filter @plexo/db exec tsx scripts/apply-orphaned-sql.ts > "$ORPHAN_OUT" 2>&1; then
    echo "[fresh-db] FAIL: apply-orphaned-sql.ts exited non-zero"
    cat "$ORPHAN_OUT"
    exit 1
fi
echo "[fresh-db] orphan apply summary:"
grep -E "^\[orphaned-sql\]" "$ORPHAN_OUT" | head -20

# ── Schema assertions ────────────────────────────────────────────────────────
# Every item below is introduced (or removed) by a migration in the 0130-0143
# range. They are the regression canary: if the orphan chain stops running on a
# fresh install, these fail here instead of the app failing later at runtime.
# Column/table/index names are taken from the migration files — do not invent.

FAILED=0

psql_count() {
    docker exec "$CONTAINER" psql -U plexo -d plexo -tAc "$1" | tr -d '[:space:]'
}

assert_column() {  # $1=table $2=column $3=migration tag
    if [ "$(psql_count "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='$1' AND column_name='$2'")" != "1" ]; then
        echo "[fresh-db] FAIL: missing column $1.$2 (expected from $3)"
        FAILED=1
    else
        echo "[fresh-db]   ok column $1.$2 ($3)"
    fi
}

assert_table() {   # $1=table $2=migration tag
    if [ "$(psql_count "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$1'")" != "1" ]; then
        echo "[fresh-db] FAIL: missing table $1 (expected from $2)"
        FAILED=1
    else
        echo "[fresh-db]   ok table $1 ($2)"
    fi
}

assert_no_table() {  # $1=table $2=migration tag that drops it
    if [ "$(psql_count "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$1'")" != "0" ]; then
        echo "[fresh-db] FAIL: table $1 should have been dropped by $2"
        FAILED=1
    else
        echo "[fresh-db]   ok $1 absent ($2)"
    fi
}

assert_index() {   # $1=index $2=migration tag
    if [ "$(psql_count "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='$1'")" != "1" ]; then
        echo "[fresh-db] FAIL: missing index $1 (expected from $2)"
        FAILED=1
    else
        echo "[fresh-db]   ok index $1 ($2)"
    fi
}

echo "[fresh-db] Asserting schema introduced by orphaned migrations 0130-0143…"

# 0130 — routing_events shadow column
assert_column routing_events shadow_model_choice 0130_routing_events_shadow
# 0131 — routing_events model_routed
assert_column routing_events model_routed 0131_routing_events_model_routed
# 0133 — provider balance exhaustion marker
assert_column provider_instances balance_exhausted_at 0133_provider_balance_exhausted
# 0134 — workspace/app grant table
assert_table workspace_app_grants 0134_workspace_app_grants
# 0135 — profile monitor observations
assert_table profile_monitor_observations 0135_profile_monitor_observations
# 0136 — hotpath indexes (CREATE INDEX CONCURRENTLY)
assert_index tasks_status_priority_created_idx 0136_hotpath_indexes
assert_index session_logs_user_idx 0136_hotpath_indexes
# 0137 — app service keys
assert_table app_service_keys 0137_app_service_keys
# 0138 — memory_embeddings retired
assert_no_table memory_embeddings 0138_drop_memory_embeddings
# 0132 created synthesis_suggestion_state; 0139 drops it
assert_no_table synthesis_suggestion_state 0139_drop_synthesis_suggestion_state
# 0140 — JEX recognitions
assert_table jex_recognitions 0140_jex_recognitions
# 0141 — session fabric (sessions table + tasks.session_id link)
assert_table sessions 0141_session_fabric
assert_column tasks session_id 0141_session_fabric
# 0142 — per-conversation overrides
assert_column conversations model_override 0142_conversation_overrides
assert_column conversations system_prompt_override 0142_conversation_overrides
# 0143 — numeric money columns across the money tables
assert_column tasks cost_usd_numeric 0143_money_numeric_expand
assert_column tasks cost_ceiling_usd_numeric 0143_money_numeric_expand
assert_column sprints cost_usd_numeric 0143_money_numeric_expand
assert_column work_ledger cost_usd_numeric 0143_money_numeric_expand
assert_column api_cost_tracking cost_usd_numeric 0143_money_numeric_expand
assert_column api_cost_tracking ceiling_usd_numeric 0143_money_numeric_expand

if [ "$FAILED" != "0" ]; then
    echo "[fresh-db] FAIL — orphaned-migration schema assertions did not hold."
    echo "[fresh-db] The 0130-0143 chain did not fully apply to a fresh DB."
    exit 1
fi

echo "[fresh-db] PASS — fresh DB stood up clean, orphan SQL applied, schema complete"
echo "[fresh-db] migrate output (tail):"
tail -20 "$MIGRATE_OUT"
