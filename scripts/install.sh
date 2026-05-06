#!/usr/bin/env bash
# =============================================================================
# Plexo — Install Script
#
# One-liner install for self-hosted Plexo. Generates secrets, writes .env,
# starts all services, waits for healthy.
#
# Usage:
#   bash <(curl -sL https://raw.githubusercontent.com/joeybuilt-official/plexo/main/scripts/install.sh) --domain=plexo.example.com
#   — or from a clone —
#   bash scripts/install.sh --domain=plexo.example.com
#
# Options:
#   --domain=DOMAIN   Required. The domain Plexo will run on (e.g. plexo.example.com)
#   --force           Overwrite existing .env (DANGEROUS — destroys secrets)
#   --no-start        Generate .env but don't run docker compose
# =============================================================================

set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

info()    { echo -e "${CYAN}[plexo]${RESET} $*"; }
success() { echo -e "${GREEN}[plexo]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[plexo]${RESET} $*"; }
die()     { echo -e "${RED}[plexo]${RESET} $*" >&2; exit 1; }

# ── Args ─────────────────────────────────────────────────────────────────────

DOMAIN=""
FORCE=false
NO_START=false

for arg in "$@"; do
  case "$arg" in
    --domain=*)  DOMAIN="${arg#*=}" ;;
    --force)     FORCE=true ;;
    --no-start)  NO_START=true ;;
    --help|-h)
      echo "Usage: bash install.sh --domain=plexo.example.com [--force] [--no-start]"
      exit 0
      ;;
    *) warn "Unknown argument: $arg" ;;
  esac
done

[[ -z "$DOMAIN" ]] && die "--domain is required. Example: bash install.sh --domain=plexo.example.com"

# ── Prerequisite checks ─────────────────────────────────────────────────────

version_gte() {
  # Returns 0 if $1 >= $2 using sort -V
  printf '%s\n%s\n' "$2" "$1" | sort -V -C
}

check_prereq() {
  local name="$1" cmd="$2" min_ver="$3" ver_cmd="$4"

  if ! command -v "$cmd" &>/dev/null; then
    die "${name} is required but not installed. Install ${name} >= ${min_ver} and retry."
  fi

  local actual
  actual=$(eval "$ver_cmd" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1) || true

  if [[ -z "$actual" ]]; then
    warn "Could not detect ${name} version. Proceeding (need >= ${min_ver})."
    return
  fi

  if ! version_gte "$actual" "$min_ver"; then
    die "${name} ${actual} found, but >= ${min_ver} is required."
  fi

  info "${name} ${actual} ${DIM}(>= ${min_ver})${RESET} ✓"
}

info "Checking prerequisites..."
check_prereq "Docker"         "docker"  "24.0"  "docker --version"
check_prereq "Docker Compose" "docker"  "2.20"  "docker compose version"
check_prereq "Bash"           "bash"    "4.0"   "bash --version"

if ! command -v openssl &>/dev/null; then
  die "openssl is required but not installed."
fi

# ── Locate repo root ────────────────────────────────────────────────────────

if [[ -f "docker-compose.yml" ]]; then
  REPO_ROOT="$(pwd)"
elif [[ -f "$(dirname "${BASH_SOURCE[0]}")/../docker-compose.yml" ]]; then
  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
else
  # Curl-pipe mode: clone the repo
  info "Cloning Plexo..."
  git clone --depth 1 https://github.com/joeybuilt-official/plexo.git plexo
  REPO_ROOT="$(cd plexo && pwd)"
fi

ENV_FILE="${REPO_ROOT}/.env"

# ── Guard existing .env ──────────────────────────────────────────────────────

if [[ -f "$ENV_FILE" && "$FORCE" == false ]]; then
  die ".env already exists at ${ENV_FILE}. Use --force to overwrite (destroys secrets)."
fi

# ── Generate secrets ─────────────────────────────────────────────────────────

info "Generating secrets..."

gen_hex()  { openssl rand -hex "$1"; }
gen_b64()  { openssl rand -base64 "$1" | tr -d '\n/+=' | head -c "$1"; }

POSTGRES_PASSWORD="$(gen_hex 32)"
REDIS_PASSWORD="$(gen_hex 32)"
SESSION_SECRET="$(gen_hex 64)"
ENCRYPTION_SECRET="$(gen_hex 32)"
AUTH_SECRET="$(gen_hex 64)"
PLEXO_SERVICE_KEY="$(gen_hex 32)"
STORAGE_ACCESS_KEY="plexo"
STORAGE_SECRET_KEY="$(gen_hex 32)"
INSTANCE_ID="$(gen_b64 16)"
TELEGRAM_WEBHOOK_SECRET="$(gen_hex 32)"
INNGEST_SIGNING_KEY="signkey-prod-$(gen_hex 32)"
INNGEST_EVENT_KEY="$(gen_hex 32)"

PUBLIC_URL="https://${DOMAIN}"
PUBLIC_DOMAIN="${DOMAIN}"

# ── Write .env ───────────────────────────────────────────────────────────────

info "Writing .env..."

cat > "$ENV_FILE" <<EOF
# =============================================================================
# Plexo — Auto-generated configuration
# Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# Domain:    ${DOMAIN}
# =============================================================================

# ── Domain ───────────────────────────────────────────────────────────────────
PUBLIC_URL=${PUBLIC_URL}
PUBLIC_DOMAIN=${PUBLIC_DOMAIN}

# ── Secrets ──────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
ENCRYPTION_SECRET=${ENCRYPTION_SECRET}
PLEXO_SERVICE_KEY=${PLEXO_SERVICE_KEY}
TELEGRAM_WEBHOOK_SECRET=${TELEGRAM_WEBHOOK_SECRET}

# ── Inngest (ADR-0006 — durable cron + workflow chaining) ───────────────────
INNGEST_SIGNING_KEY=${INNGEST_SIGNING_KEY}
INNGEST_EVENT_KEY=${INNGEST_EVENT_KEY}

# ── Auth ─────────────────────────────────────────────────────────────────────
AUTH_SECRET=${AUTH_SECRET}
BETTER_AUTH_URL=${PUBLIC_URL}

# ── Asset Storage (MinIO) ────────────────────────────────────────────────────
STORAGE_ACCESS_KEY=${STORAGE_ACCESS_KEY}
STORAGE_SECRET_KEY=${STORAGE_SECRET_KEY}
STORAGE_BUCKET=plexo-assets

# ── Instance ─────────────────────────────────────────────────────────────────
PLEXO_INSTANCE_ID=${INSTANCE_ID}

# ── Defaults ─────────────────────────────────────────────────────────────────
API_COST_CEILING_USD=10.00
MAX_SPRINT_WORKERS=5
DATA_RETENTION_DAYS=90
ALLOW_SIDELOAD=false

# ── AI Providers (add keys here or configure in-app after first login) ──────
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# GEMINI_API_KEY=
# GROQ_API_KEY=
# MISTRAL_API_KEY=

# See .env.full.example for all available configuration options.
EOF

chmod 600 "$ENV_FILE"
success ".env created at ${ENV_FILE}"

# ── Start services ───────────────────────────────────────────────────────────

if [[ "$NO_START" == true ]]; then
  success "Done. Start manually: cd ${REPO_ROOT} && docker compose --profile selfhosted up -d"
  exit 0
fi

info "Starting Plexo..."
cd "$REPO_ROOT"
docker compose --profile selfhosted up -d --build

# ── Health check polling ─────────────────────────────────────────────────────

info "Waiting for Plexo to become healthy..."

HEALTH_URL="https://${DOMAIN}/health"
MAX_WAIT=60
ELAPSED=0
INTERVAL=3

while [[ $ELAPSED -lt $MAX_WAIT ]]; do
  # Try the API container directly first (works before Caddy is ready)
  API_CONTAINER=$(docker compose ps -q api 2>/dev/null || true)
  if [[ -n "$API_CONTAINER" ]]; then
    STATUS=$(docker exec "$API_CONTAINER" wget -qO- http://127.0.0.1:3001/health 2>/dev/null || true)
    if echo "$STATUS" | grep -q "ok"; then
      break
    fi
  fi
  sleep "$INTERVAL"
  ELAPSED=$((ELAPSED + INTERVAL))
  printf "\r${CYAN}[plexo]${RESET} Waiting... %ds / %ds" "$ELAPSED" "$MAX_WAIT"
done
echo ""

if [[ $ELAPSED -ge $MAX_WAIT ]]; then
  warn "Health check timed out after ${MAX_WAIT}s. Services may still be starting."
  warn "Check status: docker compose ps"
  warn "Check logs:   docker compose logs api"
  exit 1
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  Plexo is running${RESET}"
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  URL:     ${CYAN}${PUBLIC_URL}${RESET}"
echo -e "  Config:  ${DIM}${ENV_FILE}${RESET}"
echo ""
echo -e "  Next steps:"
echo -e "  ${BOLD}1.${RESET} Open ${CYAN}${PUBLIC_URL}${RESET} and create your account"
echo -e "  ${BOLD}2.${RESET} Add an AI provider key in Settings → AI Providers"
echo -e "  ${BOLD}3.${RESET} Start building"
echo ""
echo -e "  ${DIM}All vars: .env.full.example | Logs: docker compose logs -f${RESET}"
echo ""
