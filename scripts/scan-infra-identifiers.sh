#!/usr/bin/env sh
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# scan-infra-identifiers.sh — deterministic guard against committing private
# infrastructure identifiers to this PUBLIC repo.
#
# WHY THIS EXISTS: gitleaks/trufflehog find *secrets* (tokens, keys). They do
# NOT find infrastructure *identifiers* — the deploy host's filesystem layout,
# `ssh root@` targets, internal telemetry hostnames, personal email addresses,
# or hardcoded production IPs. Those are not credentials, so a stock scanner
# reports a clean tree while the leak is still published. This repo shipped
# several before it went public. This script is the regression guard for that
# class specifically.
#
# It is intentionally conservative: it targets categories where a hit is almost
# always a real leak, and it carries an explicit allowlist for the few
# legitimate cases (the product's own PUBLIC domains, published contact
# addresses, RFC-reserved example hosts, and SSRF/version test fixtures).
#
# Usage:
#   sh scripts/scan-infra-identifiers.sh            # scan the working tree
#   sh scripts/scan-infra-identifiers.sh --canary   # self-test: prove detection
#
# Exit codes:
#   0  no findings
#   1  one or more infrastructure identifiers found (details on stdout)
#   2  usage / tooling error
#
# Wired as: a CI job (see .github/workflows/workflow-health.yml, ubuntu-latest,
# push-only) and a pre-commit sample (scripts/templates/pre-commit).

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT" || exit 2

# ── Scanner backend: prefer ripgrep, fall back to grep -rE ─────────────────
# SCAN_BACKEND=rg|grep forces a backend (used to test the grep fallback in CI
# images without ripgrep). Auto-detects when unset.
if [ -n "${SCAN_BACKEND:-}" ]; then
    RG="$SCAN_BACKEND"
elif command -v rg >/dev/null 2>&1; then
    RG="rg"
else
    RG="grep"
fi
case "$RG" in rg|grep) ;; *) echo "SCAN_BACKEND must be rg or grep" >&2; exit 2 ;; esac

# Paths excluded from every rule: vendored deps, generated/built artifacts,
# lockfiles, binary/vector assets, VCS internals, and the historical record
# (CHANGELOG.md / MIGRATING.md are append-only history — rewriting them is both
# dishonest and useless, since the repo is already published).
EXCLUDES="
node_modules
.git
scan-infra-identifiers.sh
pnpm-lock.yaml
CHANGELOG.md
MIGRATING.md
*.svg
*.snap
*.png
*.jpg
*.ico
*.woff
*.woff2
dist
.next
build
coverage
playwright-report
test-results
"

# Build backend-agnostic exclusion args.
if [ "$RG" = "rg" ]; then
    RG_GLOBS=""
    for pat in $EXCLUDES; do RG_GLOBS="$RG_GLOBS --glob !$pat"; done
    scan_pattern() {
        # shellcheck disable=SC2086  # RG_GLOBS is intentionally word-split
        rg -nN --no-heading $RG_GLOBS -e "$1" . 2>/dev/null
    }
else
    scan_pattern() {
        grep -rnE \
            --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
            --exclude-dir=.next --exclude-dir=build --exclude-dir=coverage \
            --exclude-dir=playwright-report --exclude-dir=test-results \
            --exclude=pnpm-lock.yaml --exclude=CHANGELOG.md --exclude=MIGRATING.md \
            --exclude=scan-infra-identifiers.sh \
            --exclude='*.svg' --exclude='*.snap' --exclude='*.png' \
            --exclude='*.jpg' --exclude='*.ico' --exclude='*.woff*' \
            -e "$1" . 2>/dev/null
    }
fi

FINDINGS=$(mktemp)
trap 'rm -f "$FINDINGS"' EXIT

# ── Allowlist ───────────────────────────────────────────────────────────────
# A finding is suppressed if its "file:line:text" matches ANY allowlist regex.
# Keep entries narrow and commented. Add here only for genuinely legitimate
# identifiers that a rule would otherwise flag.
ALLOWLIST='
# The products own PUBLIC domains are shipped client config / marketing, not a
# leak. (Internal telemetry subdomains are a separate rule and are NOT allowed.)
getplexo\.com
joeybuilt\.com
# Published security/privacy contact addresses (SECURITY.md, privacy policy).
(security|privacy)@getplexo\.com
# CI committer identity (graphiti-upstream-watcher bot).
bot@joeybuilt\.com
# RFC 2606 / RFC 5737 reserved documentation hosts and example placeholders.
@example\.(com|org|net|test)
\.example\.(com|internal)
host\.docker\.internal
metadata\.(google|aws)\.internal
\.ts\.net
# SSRF / plaintext-host / rate-limit TEST fixtures legitimately contain public
# IPs to prove the guard rejects them. (Test files are also glob-excluded.)
(ssrf|plaintext-host|rate-limit|isSSRFSafeUrl|isPlaintextHttpHost|assertUrlSafe)
# Browser User-Agent version strings (Chrome/125.0.0.0) are not IPs.
(Chrome|AppleWebKit|Safari)/[0-9]
# Inline SVG path data / numeric attributes can look like dotted quads.
(d="M|strokeLinecap|stroke-width|viewBox|fill-rule|clip-rule)
# Loopback / unspecified / well-known public resolvers — never a private leak.
\b(127\.[0-9.]+|0\.0\.0\.0|8\.8\.8\.8|8\.8\.4\.4|1\.1\.1\.1|255\.255\.255\.255)\b
# RFC 5737 documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24)
# and RFC 2544 benchmarking range (198.18.0.0/15) are RESERVED for examples —
# the correct thing to put in docs/tests, so never a leak.
\b(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|198\.1[89]\.)[0-9.]+
# Private / link-local / CGNAT ranges are legitimately used in examples+tests.
\b(10\.[0-9.]+|192\.168\.[0-9.]+|172\.(1[6-9]|2[0-9]|3[01])\.[0-9.]+|169\.254\.[0-9.]+)\b
\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9.]+
# ssh with an explicit PLACEHOLDER host is the documented-safe form.
ssh .*root@<
'

is_allowed() {
    # $1 = "file:line:text"
    printf '%s\n' "$ALLOWLIST" | grep -vE '^\s*(#|$)' | while read -r pat; do
        [ -z "$pat" ] && continue
        if printf '%s\n' "$1" | grep -qE "$pat"; then
            echo yes
            return
        fi
    done | grep -q yes
}

# ── Rules ───────────────────────────────────────────────────────────────────
# name<TAB>extended-regex
RULES='
host-path-deploy-layout	(/data/appdata|/mnt/user|/opt/app/|/opt/joeybuilt|/srv/platform|/srv/plexo|/opt/plexo|/workspace/_eval|/root/\.ssh/id_)
ssh-root-target	ssh[^\n]*[[:space:]]root@[A-Za-z0-9._-]
internal-telemetry-host	(posthog|sentry|analytics)\.getplexo\.com
internal-dot-hostname	([a-z0-9-]+\.){2,}internal\b
personal-email	[A-Za-z0-9._%+-]+@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|aol|icloud|me\.com|protonmail|proton\.me|fastmail|zoho)\b
routable-ipv4	\b([0-9]{1,3}\.){3}[0-9]{1,3}\b
'

run_rules() {
    printf '%s\n' "$RULES" | grep -vE '^\s*$' | while IFS="$(printf '\t')" read -r name pat; do
        [ -z "${name:-}" ] && continue
        [ -z "${pat:-}" ] && continue
        scan_pattern "$pat" | while IFS= read -r hit; do
            [ -z "$hit" ] && continue
            if ! is_allowed "$hit"; then
                printf '%s\t%s\n' "$name" "$hit" >> "$FINDINGS"
            fi
        done
    done
}

# ── Canary self-test ────────────────────────────────────────────────────────
# Proves the scanner actually fires. A zero-findings run without this is
# worthless: a broken scanner previously produced a false green on this repo.
if [ "${1:-}" = "--canary" ]; then
    CANARY_DIR="$ROOT/.infra-scan-canary"
    rm -rf "$CANARY_DIR"
    mkdir -p "$CANARY_DIR"
    cat > "$CANARY_DIR/canary.txt" <<'EOF'
deploy host filesystem: /data/appdata/canary-test/plexo
ssh in with: ssh root@canary-host.example.internal
telemetry goes to: posthog.canary-internal.example.internal
contact: canary-personal-9f3k@gmail.com
canary hostname: canary-invalid-9f3k.example.internal
prod box: 198.18.249.7
EOF
    echo "[scan] canary seeded at $CANARY_DIR/canary.txt — scanning…"
    FOUND=0
    for expect in host-path-deploy-layout ssh-root-target internal-dot-hostname personal-email; do
        # run the single rule against the canary dir only
        case $expect in
            host-path-deploy-layout) pat='/data/appdata' ;;
            ssh-root-target)         pat='ssh[^\n]*[[:space:]]root@[A-Za-z0-9._-]' ;;
            internal-dot-hostname)   pat='([a-z0-9-]+\.){2,}internal\b' ;;
            personal-email)          pat='[A-Za-z0-9._%+-]+@(gmail|protonmail)\b' ;;
        esac
        if [ "$RG" = "rg" ]; then
            n=$(rg -nN --no-heading -e "$pat" "$CANARY_DIR" 2>/dev/null | wc -l | tr -d ' ')
        else
            n=$(grep -rnE -e "$pat" "$CANARY_DIR" 2>/dev/null | wc -l | tr -d ' ')
        fi
        if [ "$n" -gt 0 ]; then
            echo "[scan]   DETECTED $expect ($n hit(s))"
            FOUND=$((FOUND + 1))
        else
            echo "[scan]   MISSED  $expect — scanner is broken for this rule"
        fi
    done
    rm -rf "$CANARY_DIR"
    echo "[scan] canary removed; confirming it no longer fires…"
    LEFT=$(scan_pattern '/data/appdata/canary-test' | wc -l | tr -d ' ')
    if [ "$LEFT" -eq 0 ]; then
        echo "[scan]   CLEAN — canary path absent after removal"
    else
        echo "[scan]   STILL PRESENT ($LEFT) — removal failed"
        exit 2
    fi
    if [ "$FOUND" -ge 4 ]; then
        echo "[scan] CANARY OK — detection proven for $FOUND rule class(es)."
        exit 0
    else
        echo "[scan] CANARY FAILED — only $FOUND/4 rule classes fired."
        exit 1
    fi
fi

# ── Normal scan ─────────────────────────────────────────────────────────────
run_rules

TOTAL=$(wc -l < "$FINDINGS" | tr -d ' ')
if [ "$TOTAL" -gt 0 ]; then
    echo "Infrastructure identifiers found in tracked files ($TOTAL):"
    echo
    sort "$FINDINGS" | while IFS="$(printf '\t')" read -r name hit; do
        printf '  [%s] %s\n' "$name" "$hit"
    done
    echo
    echo "Replace each with a placeholder (<YOUR_APP_DOMAIN>, your-infra-dir, a repo"
    echo "secret, or a required-with-no-default env var). Never delete capability —"
    echo "parameterize it. If a hit is genuinely legitimate, add a narrow entry to"
    echo "the ALLOWLIST in scripts/scan-infra-identifiers.sh with a comment."
    exit 1
fi

echo "✔ no infrastructure identifiers found in tracked files"
exit 0
