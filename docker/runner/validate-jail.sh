#!/bin/sh
# validate-jail.sh (ADR 0050 / plan §9-D2). Run ON NAS against a STARTED jail
# container:  docker exec <runner-container> /path/to/validate-jail.sh
# NOT a CI check — it asserts live kernel/namespace confinement on the host.
# Exits nonzero if ANY control fails.
fail=0
pass() { echo "PASS: $1"; }
bad()  { echo "FAIL: $1"; fail=1; }

# 1. process is not uid 0
if [ "$(id -u)" != "0" ]; then pass "uid != 0 ($(id -u))"; else bad "running as root"; fi

# 2. rootfs read-only — writing to / must fail
if ( : > /x ) 2>/dev/null; then bad "/ is writable"; rm -f /x 2>/dev/null || true; else pass "/ read-only"; fi

# 3. /work writable
if ( : > /work/.probe ) 2>/dev/null; then pass "/work writable"; rm -f /work/.probe 2>/dev/null || true; else bad "/work not writable"; fi

# 4. egress default-deny — external fetch must fail/time out
if wget -T 3 -q -O- https://example.com >/dev/null 2>&1; then bad "external egress reachable"; else pass "external egress blocked"; fi

# 5. namespace escape denied (best-effort) — unshare must fail
if unshare -U true >/dev/null 2>&1; then bad "unshare -U succeeded (namespace escape possible)"; else pass "unshare denied"; fi

[ "$fail" = "0" ] && echo "ALL CHECKS PASSED" || echo "ONE OR MORE CHECKS FAILED"
exit "$fail"
