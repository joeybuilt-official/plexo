#!/usr/bin/env bash
# Read-only prod-state spot-check for the plexo-gmessages sidecar.
#
# Wraps the recurring autonomous-prep "session-start spot-check" pattern into
# a single command. Surfaces PASS/WARN lines plus an INFO line per
# non-comparable metric (sidecar mem, paired_sessions count) so a reader can
# eyeball drift quickly.
#
# Canonical anchor: PHASE-6-OPS §12.3 (Session-start ritual). Pair this with
# scripts/check-platform-compose-drift.sh — both run before any other work.
#
# Usage:
#   bash scripts/check-gmessages-prod-state.sh
#
# Env overrides:
#   PLEXO_VPS_HOST        default root@203.0.113.10
#   PLEXO_VPS_KEY         default ~/.ssh/joeybuilt_vps
#   PLEXO_EXPECTED_VERSION default 0.0.5-phase-6-ops
#
# Exit codes:
#   0  green — every comparable check matched expectations.
#   1  could not reach prod (ssh failure / sidecar absent).

set -uo pipefail

VPS="${PLEXO_VPS_HOST:-root@203.0.113.10}"
KEY="${PLEXO_VPS_KEY:-$HOME/.ssh/joeybuilt_vps}"
EXPECTED_VERSION="${PLEXO_EXPECTED_VERSION:-0.0.5-phase-6-ops}"

ssh_run() { ssh -o ConnectTimeout=10 -i "$KEY" "$VPS" "$@" 2>/dev/null; }

PASS=0; WARN=0
ok()   { echo "[spot-check] PASS: $1"; PASS=$((PASS+1)); }
warn() { echo "[spot-check] WARN: $1"; WARN=$((WARN+1)); }
info() { echo "[spot-check] INFO: $1"; }

# 1. Sidecar container status.
status=$(ssh_run "docker ps --filter name=plexo-gmessages --format '{{.Status}}'")
if [ -z "$status" ]; then
    echo "[spot-check] FAIL: sidecar container not running on $VPS" >&2
    exit 1
fi
if echo "$status" | grep -q "(healthy)"; then
    ok "sidecar status — $status"
else
    warn "sidecar status unexpected — '$status'"
fi

# 2. Sidecar version.
version=$(ssh_run "docker exec plexo-gmessages /gmessages -version" | tr -d '[:space:]')
if [ "$version" = "$EXPECTED_VERSION" ]; then
    ok "sidecar version = $version"
else
    warn "sidecar version = '$version' (expected '$EXPECTED_VERSION')"
fi

# 3. Boot logs — confirm canonical 3-line sequence.
logs=$(ssh_run "docker logs --tail 20 plexo-gmessages 2>&1")
ok_listener=$(echo "$logs" | grep -c "http listener up" || true)
ok_selfcheck=$(echo "$logs" | grep -c "startup HMAC self-check passed" || true)
ok_restore=$(echo "$logs"   | grep -c "boot restore: rehydrating sessions" || true)
if [ "$ok_listener" -ge 1 ] && [ "$ok_selfcheck" -ge 1 ] && [ "$ok_restore" -ge 1 ]; then
    ok "boot logs canonical (listener + self-check + boot-restore)"
else
    warn "boot logs missing canonical lines — listener=$ok_listener selfcheck=$ok_selfcheck restore=$ok_restore"
fi

# 4. Drizzle migration state — MAX(created_at) + NULL count.
mig_state=$(ssh_run "docker exec postgres psql -U postgres -d plexo -t -A \
    -c \"SELECT MAX(created_at), COUNT(*) FILTER (WHERE created_at IS NULL) FROM drizzle.__drizzle_migrations;\"")
mig_max=$(echo  "$mig_state" | cut -d'|' -f1)
mig_nulls=$(echo "$mig_state" | cut -d'|' -f2)
if [ "$mig_nulls" = "0" ]; then
    ok "__drizzle_migrations MAX(created_at)=$mig_max, NULLs=0"
else
    warn "__drizzle_migrations NULLs=$mig_nulls (expected 0; see PHASE-6-OPS §3.3 backfill)"
fi

# 5. Paired sessions count (informational; rises after smoke runs).
sess_count=$(ssh_run "docker exec postgres psql -U postgres -d plexo -t -A \
    -c \"SELECT count(*) FROM plexo_gmessages.paired_sessions;\"")
info "paired_sessions count = ${sess_count:-?}"

# 6. Decode-error rollup — cross-workspace sum.
decode_errs=$(ssh_run "docker exec postgres psql -U postgres -d plexo -t -A \
    -c \"SELECT COALESCE(SUM(decode_error_count), 0) FROM plexo_gmessages.paired_sessions;\"")
if [ "${decode_errs:-0}" = "0" ]; then
    ok "decode_error_rollup = 0"
else
    warn "decode_error_rollup = $decode_errs (RUNBOOK §3 protocol-drift triage?)"
fi

# 7. Sidecar memory — informational (cap is 256 MiB; PROGRESS notes ~4.8 MiB steady-state).
mem=$(ssh_run "docker stats plexo-gmessages --no-stream --format '{{.MemUsage}}'" | head -1)
info "sidecar mem = ${mem:-?} (cap 256 MiB)"

echo
echo "[spot-check] $PASS PASS / $WARN WARN"
[ "$WARN" -eq 0 ] && echo "[spot-check] all comparable checks green."
exit 0
