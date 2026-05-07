#!/usr/bin/env bash
# Combined PHASE-6-OPS §12.3 session-start ritual: runs both drift-check
# wrappers in sequence and surfaces a single PASS/FAIL gate. Use this as the
# first command in every autonomous Phase 6 closeout-window session.
#
# This is intentionally a thin shim around the two underlying wrappers — they
# remain the source of truth for their respective check sets. Run them
# directly when you want layered output.
#
# Usage:
#   bash scripts/session-start.sh
#
# Exit codes:
#   0  both wrappers green — safe to proceed with autonomous work.
#   1  one or both wrappers failed; investigate before any §12.4 work.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RC=0

echo "[session-start] === scripts/check-gmessages-prod-state.sh ==="
bash "$ROOT/scripts/check-gmessages-prod-state.sh" || RC=$?
echo
echo "[session-start] === scripts/check-platform-compose-drift.sh ==="
bash "$ROOT/scripts/check-platform-compose-drift.sh" || RC=$?
echo

if [[ $RC -eq 0 ]]; then
    echo "[session-start] PASS — both drift-check wrappers green; safe to proceed with §12.4 work."
else
    echo "[session-start] FAIL — at least one wrapper returned non-zero ($RC). Stop and report drift to operator per §12.8 exit conditions."
fi

exit $RC
