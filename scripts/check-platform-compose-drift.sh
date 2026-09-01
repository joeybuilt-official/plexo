#!/usr/bin/env bash
# Read-only drift check for the inline `plexo-gmessages` edit on the deploy
# host at /srv/platform/infra/docker-compose.yml.
#
# Pre-flight before PHASE-6-OPS §3.5 (persist plexo-gmessages to upstream
# platform repo). The §3.5 workflow requires `git --no-pager diff` to match the
# 2026-05-06 22:47 UTC inline edit byte-for-byte; if anything else has touched
# the compose file in the intervening window, the operator must reconcile
# before pushing. This wrapper just SSHes, runs the diff, hashes it, and
# compares against the captured baseline below.
#
# Also part of the §12.3 session-start ritual — pair with
# scripts/check-gmessages-prod-state.sh; both run before any other work.
#
# Usage:
#   bash scripts/check-platform-compose-drift.sh
#
# Env overrides:
#   PLEXO_DEPLOY_HOST  default root@<prod-server-ip>
#   PLEXO_DEPLOY_KEY   default ~/.ssh/deploy-key
#
# The former PLEXO_VPS_HOST / PLEXO_VPS_KEY names are still accepted as a
# deprecated fallback; they will be removed in a future release.
#
# Exit codes:
#   0  no drift — diff matches baseline byte-for-byte; safe to paste §3.5 workflow.
#   1  drift detected OR could not reach prod; full live diff dumped to stdout.
#
# Refreshing the baseline (if §3.5 lands and the file gets re-edited later):
#   1. ssh -i ~/.ssh/deploy-key root@<prod-server-ip> \
#        'cd /srv/platform && git --no-pager diff infra/docker-compose.yml' \
#        > /tmp/platform-compose-diff.txt
#   2. wc -l < /tmp/platform-compose-diff.txt   # → BASELINE_LINES
#   3. sha256sum /tmp/platform-compose-diff.txt # → BASELINE_SHA256
#   4. Update the two constants below + PHASE-6-OPS §3.5's verbatim diff block.

set -uo pipefail

HOST="${PLEXO_DEPLOY_HOST:-${PLEXO_VPS_HOST:-root@<prod-server-ip>}}"
KEY="${PLEXO_DEPLOY_KEY:-${PLEXO_VPS_KEY:-$HOME/.ssh/deploy-key}}"

# Baseline captured 2026-05-06 evening — `git --no-pager diff infra/docker-compose.yml`
# on /srv/platform; matches PHASE-6-OPS §3.5 verbatim block.
BASELINE_LINES=43
BASELINE_SHA256="911d054c136ba01484bb966a8564bae906a4ae07957f4c0710f2322fa035639d"
BASELINE_TS="2026-05-06T22:47Z (inline edit) / captured evening 2026-05-06"

ssh_run() { ssh -o ConnectTimeout=10 -i "$KEY" "$HOST" "$@"; }

ok()   { echo "[drift-check] PASS: $1"; }
warn() { echo "[drift-check] WARN: $1"; }
fail() { echo "[drift-check] FAIL: $1" >&2; }

# 1. Confirm the platform repo is reachable + on main.
branch=$(ssh_run "cd /srv/platform && git rev-parse --abbrev-ref HEAD" 2>/dev/null)
if [ -z "$branch" ]; then
    fail "could not reach /srv/platform on $HOST"
    exit 1
fi
if [ "$branch" = "main" ]; then
    ok "platform repo on branch=main"
else
    warn "platform repo on branch='$branch' (expected main)"
fi

# 2. Capture live diff.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
ssh_run "cd /srv/platform && git --no-pager diff infra/docker-compose.yml" > "$tmp" 2>/dev/null

live_lines=$(wc -l < "$tmp")
live_sha=$(sha256sum "$tmp" | cut -d' ' -f1)

# 3. Empty diff = the §3.5 push has already landed (or someone reverted the inline edit).
if [ "$live_lines" -eq 0 ]; then
    warn "live diff is empty — §3.5 push may have already landed (or inline edit reverted)"
    warn "if §3.5 just landed, retire this drift-check baseline; if not, investigate."
    exit 1
fi

# 4. Compare against baseline.
if [ "$live_sha" = "$BASELINE_SHA256" ]; then
    ok "live diff sha256 matches baseline ($BASELINE_SHA256)"
    ok "live diff line count = $live_lines (baseline $BASELINE_LINES)"
    echo "[drift-check] no drift since $BASELINE_TS — safe to paste §3.5 workflow."
    exit 0
fi

# 5. Drift — surface details.
fail "live diff sha256 = $live_sha (baseline $BASELINE_SHA256)"
fail "live diff line count = $live_lines (baseline $BASELINE_LINES)"
echo
echo "[drift-check] === LIVE DIFF (someone has touched the file since $BASELINE_TS) ===" >&2
cat "$tmp" >&2
echo "[drift-check] === END LIVE DIFF ===" >&2
echo "[drift-check] reconcile against PHASE-6-OPS §3.5 verbatim block before pushing." >&2
exit 1
