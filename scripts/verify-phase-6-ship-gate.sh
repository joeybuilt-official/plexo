#!/usr/bin/env bash
# PLEXO-GMESSAGES Phase 6 ship-gate verification battery.
# Runs every static check from PLEXO-GMESSAGES-PHASE-6-OPS.md §10 in sequence,
# redirecting noisy output to /tmp logs and surfacing only PASS/FAIL/WARN lines.
#
# Usage:
#   bash scripts/verify-phase-6-ship-gate.sh
#
# Exits 0 on all-green; exits 1 on the first hard-fail.
# WARN-level: api typecheck has 3 pre-existing errors on deepgram.ts +
# telegram.ts (Buffer/BlobPart, carried forward from Phase 4b per CLAUDE.md) —
# script reports them as a warning but does not fail the gate. Dockerfile.api
# runs the api via tsx at runtime, not a tsc compile step, so these errors do
# not block deploy.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$(mktemp -d /tmp/plexo-ship-gate.XXXXXX)"
trap 'echo "[ship-gate] logs preserved at $LOG_DIR"' EXIT

PASS=0; WARN=0
fail() { echo "[ship-gate] FAIL: $1 (log: $2)"; tail -30 "$2"; exit 1; }
ok()   { echo "[ship-gate] PASS: $1"; PASS=$((PASS+1)); }
warn() { echo "[ship-gate] WARN: $1"; WARN=$((WARN+1)); }

# 1. API typecheck — TOLERATE 3 pre-existing errors on deepgram.ts + telegram.ts.
API_LOG="$LOG_DIR/api-typecheck.log"
echo "[ship-gate] api typecheck (3 pre-existing errors expected)..."
if pnpm -F @plexo/api typecheck > "$API_LOG" 2>&1; then
    ok "api typecheck (zero errors)"
else
    TOTAL=$(grep -cE "error TS[0-9]+" "$API_LOG" || true)
    PREEX=$(grep -cE "(deepgram|telegram)\.ts.*error TS[0-9]+" "$API_LOG" || true)
    if [ "${TOTAL:-0}" -le 3 ] && [ "${PREEX:-0}" -ge 1 ] && [ "${TOTAL:-0}" -eq "${PREEX:-0}" ]; then
        warn "api typecheck — $TOTAL pre-existing errors on deepgram/telegram (per CLAUDE.md)"
    else
        fail "api typecheck (unexpected: $TOTAL total, $PREEX pre-existing)" "$API_LOG"
    fi
fi

# 2. Queue typecheck.
QUEUE_LOG="$LOG_DIR/queue-typecheck.log"
echo "[ship-gate] queue typecheck..."
if pnpm -F @plexo/queue typecheck > "$QUEUE_LOG" 2>&1; then
    ok "queue typecheck"
else
    fail "queue typecheck" "$QUEUE_LOG"
fi

# 3. Web typecheck.
WEB_LOG="$LOG_DIR/web-typecheck.log"
echo "[ship-gate] web typecheck..."
if pnpm -F @plexo/web typecheck > "$WEB_LOG" 2>&1; then
    ok "web typecheck"
else
    fail "web typecheck" "$WEB_LOG"
fi

# 4. SaaS build.
SAAS_LOG="$LOG_DIR/saas-build.log"
echo "[ship-gate] saas build..."
if pnpm --filter @plexo/saas build > "$SAAS_LOG" 2>&1; then
    ok "saas build"
else
    fail "saas build" "$SAAS_LOG"
fi

echo
echo "[ship-gate] ============================================"
echo "[ship-gate] Phase 6 ship-gate verification: $PASS passed, $WARN warnings"
echo "[ship-gate] All hard gates green."
if [ "$WARN" -gt 0 ]; then
    echo "[ship-gate] (warnings are pre-existing per CLAUDE.md — not blocking)"
fi
echo "[ship-gate] ============================================"

exit 0
