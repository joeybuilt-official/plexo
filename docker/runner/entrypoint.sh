#!/bin/sh
# Runner jail entrypoint (ADR 0050 / plan §9-D2). POSIX sh.
# chmod +x is applied at image BUILD time (read_only rootfs at runtime).
set -eu

# (a) Refuse to run as root — defence in depth behind USER 10001 / user: "10001:10001".
[ "$(id -u)" != "0" ] || { echo "refuse: running as root"; exit 1; }

# (b) Wall-clock ceiling. RUNNER_WALLCLOCK_MS is milliseconds. GNU timeout's ms
# suffix is not portable, so convert to whole seconds (integer, min 1) — robust
# POSIX form. Strip any fractional part first.
MS="${RUNNER_WALLCLOCK_MS:-120000}"
MS="${MS%.*}"
SECS=$(( MS / 1000 ))
[ "$SECS" -ge 1 ] || SECS=1

# (c) Exec the runner under the timeout. Placeholder entry — the real runner
# module is wired in a later slice.
exec timeout -s KILL "${SECS}s" node /app/runner.js "$@"
