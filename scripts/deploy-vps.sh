#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# Copyright (C) 2026 Joeybuilt LLC
#
# deploy-vps.sh — deploy Plexo to a production VPS.
#
# Picks the right docker compose services based on `git diff` between
# origin/main and HEAD~1, then runs the rebuild + restart sequence on
# the VPS. Verifies the new code actually landed in the right
# container by inspecting the built artifacts.
#
# The dashboard is `plexo-saas`. Picking the wrong service is the #1
# deploy mistake — see AGENTS.md "Deploy sequence" for the full table.
# This script enforces the mapping so it can't be fat-fingered.
#
# Usage:
#   ./scripts/deploy-vps.sh                      # auto-detect from git diff
#   ./scripts/deploy-vps.sh plexo-api            # force one service
#   ./scripts/deploy-vps.sh plexo-api plexo-saas # force several
#   ./scripts/deploy-vps.sh --all                # rebuild every plexo service
#
# Env vars:
#   VPS_HOST     (required) target VPS IP or hostname
#   VPS_USER     default root
#   VPS_KEY      (required) path to SSH private key
#   VPS_REPO     default /opt/plexo
#   COMPOSE_DIR  default /opt/app/infra
#   COMPOSE_BASE     default docker-compose.yml
#   COMPOSE_OVERRIDE default docker-compose.prod.yml
#   APP_DOMAIN   default getplexo.com

set -euo pipefail

VPS_HOST="${VPS_HOST:?VPS_HOST must be set (target VPS IP or hostname)}"
VPS_USER="${VPS_USER:-root}"
VPS_KEY="${VPS_KEY:?VPS_KEY must be set (path to SSH private key)}"
VPS_REPO="${VPS_REPO:-/opt/plexo}"
COMPOSE_DIR="${COMPOSE_DIR:-/opt/app/infra}"
COMPOSE_BASE="${COMPOSE_BASE:-docker-compose.yml}"
COMPOSE_OVERRIDE="${COMPOSE_OVERRIDE:-docker-compose.prod.yml}"
APP_DOMAIN="${APP_DOMAIN:-getplexo.com}"

ssh_run() {
  ssh -o StrictHostKeyChecking=no -i "$VPS_KEY" "$VPS_USER@$VPS_HOST" "$@"
}

# ── Service map ──────────────────────────────────────────────────────────
#
# Each entry: <compose-service>:<container-name>:<path-glob1>,<path-glob2>...
# A path glob matches when any changed file starts with one of its prefixes.
#
# This is the SINGLE source of truth for what gets rebuilt when. AGENTS.md
# documents the same map for human readers; this script uses it for the
# auto-detect path.
#
# Order matters for verification: api/saas/hub. If you add a new service,
# add it here AND update AGENTS.md "Deploy sequence" in the same commit.

SERVICE_MAP=(
  "plexo-api:plexo-api:apps/api/,packages/agent/,packages/db/,packages/queue/,packages/scl-core/,packages/sdk/,packages/storage/,packages/mcp-server/"
  "plexo-saas:plexo-saas:apps/web/,packages/agent/,packages/db/,packages/sdk/,packages/storage/"
  "plexo-hub:plexo-hub:apps/hub/,packages/db/,packages/sdk/"
)

# ── Helpers ──────────────────────────────────────────────────────────────

color() { printf "\033[%sm%s\033[0m" "$1" "$2"; }
info()  { echo "$(color "1;34" "==>") $*"; }
ok()    { echo "$(color "1;32" " ✓") $*"; }
warn()  { echo "$(color "1;33" " ⚠") $*"; }
die()   { echo "$(color "1;31" " ✗") $*" >&2; exit 1; }

print_service_map() {
  echo "Plexo deploy targets:"
  for entry in "${SERVICE_MAP[@]}"; do
    local svc="${entry%%:*}"
    local rest="${entry#*:}"
    local container="${rest%%:*}"
    echo "  - $svc ($container)"
  done
  echo
  echo "plexo-web is NOT in this list — it is the marketing site (a different repo)."
}

detect_services_from_diff() {
  local base
  base="$(git merge-base origin/main HEAD 2>/dev/null || echo "HEAD~1")"
  local files
  files="$(git diff --name-only "$base" HEAD 2>/dev/null || true)"
  if [[ -z "$files" ]]; then
    files="$(git diff --name-only HEAD~1 HEAD 2>/dev/null || true)"
  fi
  if [[ -z "$files" ]]; then
    warn "Could not compute git diff — falling back to all plexo-* services"
    for entry in "${SERVICE_MAP[@]}"; do echo "${entry%%:*}"; done
    return
  fi

  local -A hit
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    for entry in "${SERVICE_MAP[@]}"; do
      local svc="${entry%%:*}"
      local rest="${entry#*:}"
      local globs="${rest#*:}"
      IFS=',' read -ra prefixes <<< "$globs"
      for p in "${prefixes[@]}"; do
        if [[ "$f" == "$p"* ]]; then
          hit["$svc"]=1
        fi
      done
    done
  done <<< "$files"

  for entry in "${SERVICE_MAP[@]}"; do
    local svc="${entry%%:*}"
    [[ -n "${hit[$svc]:-}" ]] && echo "$svc"
  done
}

container_for() {
  local svc="$1"
  for entry in "${SERVICE_MAP[@]}"; do
    if [[ "${entry%%:*}" == "$svc" ]]; then
      local rest="${entry#*:}"
      echo "${rest%%:*}"
      return
    fi
  done
  die "Unknown service: $svc (not in plexo deploy map; see AGENTS.md)"
}

verify_service() {
  local svc="$1"
  local container; container="$(container_for "$svc")"
  case "$svc" in
    plexo-api)
      ssh_run "docker exec $container ls /app/apps/api/src/index.ts" >/dev/null \
        && ok "$container source present" || die "$container source missing"
      ;;
    plexo-saas)
      ssh_run "docker exec $container ls /app/apps/web/.next/server/app/app" >/dev/null \
        && ok "$container .next/server/app/app built" || die "$container missing /app routes — wrong service rebuilt?"
      ;;
    plexo-hub)
      ssh_run "docker exec $container ls /app/apps/hub" >/dev/null \
        && ok "$container present" || die "$container missing"
      ;;
  esac
}

# ── Main ─────────────────────────────────────────────────────────────────

cd "$(git rev-parse --show-toplevel)"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,33p' "$0"
  echo
  print_service_map
  exit 0
fi

local_head="$(git rev-parse HEAD)"
remote_head="$(git ls-remote origin main | awk '{print $1}')"
if [[ "$local_head" != "$remote_head" ]]; then
  die "Local HEAD ($local_head) differs from origin/main ($remote_head). Push first."
fi

# Pick services
services=()
if [[ "${1:-}" == "--all" ]]; then
  for entry in "${SERVICE_MAP[@]}"; do services+=("${entry%%:*}"); done
elif [[ $# -gt 0 ]]; then
  for arg in "$@"; do
    container_for "$arg" >/dev/null  # validates
    services+=("$arg")
  done
else
  info "Auto-detecting services from git diff…"
  while IFS= read -r s; do services+=("$s"); done < <(detect_services_from_diff)
fi

if [[ ${#services[@]} -eq 0 ]]; then
  warn "No services to deploy. Exiting."
  exit 0
fi

info "Deploying to $VPS_USER@$VPS_HOST: ${services[*]}"

# Pull on VPS
info "Pulling latest on VPS…"
ssh_run "cd $VPS_REPO && git pull origin main" >/dev/null
ok "VPS pulled to $local_head"

# Build
info "Building: ${services[*]} (this may take a few minutes)…"
build_args="${services[*]}"
if ! ssh_run "cd $COMPOSE_DIR && docker compose -f $COMPOSE_BASE -f $COMPOSE_OVERRIDE build --no-cache $build_args"; then
  warn "Build failed. Common cause: disk pressure. Try:"
  echo "  ssh -i $VPS_KEY $VPS_USER@$VPS_HOST \"docker builder prune -af && docker image prune -af\""
  die "Aborting — fix disk and re-run."
fi
ok "Built: ${services[*]}"

# Restart
info "Restarting: ${services[*]}…"
ssh_run "cd $COMPOSE_DIR && docker compose -f $COMPOSE_BASE -f $COMPOSE_OVERRIDE up -d --force-recreate --no-deps $build_args"
ok "Restarted"

sleep 5

# Verify each service
info "Verifying built artifacts present in containers…"
for svc in "${services[@]}"; do
  verify_service "$svc"
done

# Health check
info "Smoke test: https://$APP_DOMAIN/health"
if curl -sm5 "https://$APP_DOMAIN/health" | grep -q '"status":"ok"'; then
  ok "Health check passed"
else
  warn "Health check did not return status:ok — investigate before declaring success"
fi

ok "Deploy complete: ${services[*]} on $local_head"
