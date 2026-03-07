#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="/tmp/plexo-update.log"
COMPOSE_FILE="${COMPOSE_FILE:-docker/compose.yml}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"; }

log "Starting Plexo self-update from ${REPO_DIR}"
cd "$REPO_DIR"

# Managed hosting: skip Docker steps, only pull code
if [[ "${PLEXO_MANAGED:-false}" == "true" ]]; then
    log "Managed instance detected — pulling code only (no Docker restart)"
    git fetch origin main
    git reset --hard origin/main
    log "Code updated. Managed host handles restarts automatically."
    exit 0
fi

# Stash any local uncommitted changes to avoid conflicts
if git diff --quiet && git diff --cached --quiet; then
    log "Working tree clean — no stash needed"
else
    log "Stashing local changes"
    git stash --include-untracked || true
fi

# Pull latest from origin/main
log "Fetching latest code from origin/main"
git fetch origin main
git reset --hard origin/main

# Restore stash (best effort — non-fatal)
git stash pop 2>/dev/null && log "Stash restored" || log "No stash to restore"

# Install dependencies
log "Installing dependencies"
pnpm install --frozen-lockfile

# Run DB migrations
log "Running database migrations"
pnpm --filter @plexo/db db:migrate

# Check whether docker compose is available
if ! command -v docker &>/dev/null; then
    log "Docker not found — skipping container rebuild. Restart the API/web processes manually."
    exit 0
fi

# Build compose arguments
COMPOSE_ARGS="-f ${COMPOSE_FILE}"
if [ -f "docker/compose.override.yml" ]; then
    log "Using docker/compose.override.yml"
    COMPOSE_ARGS="$COMPOSE_ARGS -f docker/compose.override.yml"
fi

# Rebuild and restart via Docker Compose
log "Building Docker images"
docker compose $COMPOSE_ARGS build --no-cache api web

log "Restarting containers"
docker compose $COMPOSE_ARGS up -d --remove-orphans

log "Plexo self-update complete"
