#!/usr/bin/env bash
# =============================================================================
# Plexo — Install Script
#
# Generates all required secrets and creates a ready-to-run .env file.
# Run once on a fresh server. If .env already exists, nothing is overwritten.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/joeybuilt-official/plexo/main/scripts/install.sh | bash
#   — or —
#   bash scripts/install.sh
#
# Options:
#   --domain=plexo.example.com   Set PUBLIC_DOMAIN (required for TLS)
#   --force                      Overwrite existing .env (DANGEROUS — loses secrets)
# =============================================================================

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}[plexo]${RESET} $*"; }
success() { echo -e "${GREEN}[plexo]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[plexo]${RESET} $*"; }
error()   { echo -e "${RED}[plexo]${RESET} $*" >&2; }

# ── Args ──────────────────────────────────────────────────────────────────────

DOMAIN=""
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --domain=*) DOMAIN="${arg#*=}" ;;
    --force)    FORCE=true ;;
    *)          warn "Unknown argument: $arg" ;;
  esac
done

# ── Locate repo root (works whether run from scripts/ or repo root) ────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
EXAMPLE_FILE="${REPO_ROOT}/.env.example"

# ── Pre-flight checks ─────────────────────────────────────────────────────────

if ! command -v openssl &>/dev/null; then
  error "openssl is required but not installed. Install it and retry."
  exit 1
fi

if ! command -v docker &>/dev/null; then
  warn "docker not found — you can still generate .env but can't start services."
fi

if [[ -f "$ENV_FILE" && "$FORCE" == false ]]; then
  warn ".env already exists at ${ENV_FILE}"
  warn "Secrets are preserved. Run with --force to regenerate (DESTROYS existing secrets)."
  echo ""
  # Still run the rest — validate what's there
  _VALIDATE_ONLY=true
else
  _VALIDATE_ONLY=false
fi

# ── Secret generator ──────────────────────────────────────────────────────────

gen_hex() { openssl rand -hex "$1"; }
gen_b64() { openssl rand -base64 "$1" | tr -d '\n/+=' | head -c "$1"; }

# ── Domain prompt ─────────────────────────────────────────────────────────────

if [[ -z "$DOMAIN" && "$_VALIDATE_ONLY" == false ]]; then
  echo ""
  info "What domain will Plexo run on? (e.g. plexo.example.com)"
  info "Leave blank to configure later."
  read -rp "  Domain: " DOMAIN
  DOMAIN="${DOMAIN:-plexo.yourdomain.com}"
fi

# ── Generate ──────────────────────────────────────────────────────────────────

if [[ "$_VALIDATE_ONLY" == false ]]; then
  POSTGRES_PASSWORD="$(gen_hex 32)"
  SESSION_SECRET="$(gen_hex 64)"
  ENCRYPTION_SECRET="$(gen_hex 32)"
  STORAGE_SECRET_KEY="$(gen_hex 32)"
  STORAGE_ACCESS_KEY="plexo"
  INSTANCE_ID="$(gen_b64 16)"

  PUBLIC_URL="https://${DOMAIN}"
  PUBLIC_DOMAIN="${DOMAIN}"

  info "Generating .env with secure secrets…"

  cat > "$ENV_FILE" <<EOF
# =============================================================================
# Plexo — Auto-generated configuration
# Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# =============================================================================

# ── Required ──────────────────────────────────────────────────────────────────

# Database (auto-generated — do not change unless you recreate the volume)
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# Public URL for OAuth callbacks and external links
PUBLIC_URL=${PUBLIC_URL}
PUBLIC_DOMAIN=${PUBLIC_DOMAIN}

# Session + credential encryption (auto-generated)
# KEEP THESE SECRET. If lost, all encrypted credentials must be re-entered.
SESSION_SECRET=${SESSION_SECRET}
ENCRYPTION_SECRET=${ENCRYPTION_SECRET}

# Plexo instance identifier (used for telemetry if enabled)
PLEXO_INSTANCE_ID=${INSTANCE_ID}

# ── Asset Storage (MinIO — auto-configured by Docker Compose) ─────────────────
# These match MinIO's MINIO_ROOT_USER / MINIO_ROOT_PASSWORD.
# Only override STORAGE_ENDPOINT to use external S3/R2/B2.
STORAGE_ACCESS_KEY=${STORAGE_ACCESS_KEY}
STORAGE_SECRET_KEY=${STORAGE_SECRET_KEY}
STORAGE_BUCKET=plexo-assets
# STORAGE_ENDPOINT=https://s3.amazonaws.com   # uncomment for external S3

# ── AI Providers (at least one required for agent tasks) ──────────────────────

ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=
MISTRAL_API_KEY=

# ── Channel Integrations (optional) ───────────────────────────────────────────

# Telegram — get from @BotFather
TELEGRAM_BOT_TOKEN=

# Slack — api.slack.com/apps
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=

# Discord — discord.com/developers/applications
DISCORD_APP_ID=
DISCORD_PUBLIC_KEY=
DISCORD_BOT_TOKEN=

# GitHub OAuth — github.com/settings/applications/new
# Callback: \${PUBLIC_URL}/api/oauth/github/callback
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Google OAuth — console.cloud.google.com
# Callback: \${PUBLIC_URL}/api/oauth/google/callback
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# ── Cost Controls ─────────────────────────────────────────────────────────────

API_COST_CEILING_USD=10.00
MAX_SPRINT_WORKERS=5

# ── Voice (Deepgram) ──────────────────────────────────────────────────────────

DEEPGRAM_API_KEY=

# ── Observability (optional) ──────────────────────────────────────────────────

# PostHog — posthog.com (self-hosted or cloud)
POSTHOG_API_KEY=
EOF

  chmod 600 "$ENV_FILE"
  success ".env created at ${ENV_FILE}"
fi

# ── Validate required fields ──────────────────────────────────────────────────

echo ""
info "Validating secrets…"

REQUIRED_SECRETS=("POSTGRES_PASSWORD" "SESSION_SECRET" "ENCRYPTION_SECRET" "STORAGE_SECRET_KEY")
MISSING=()

for key in "${REQUIRED_SECRETS[@]}"; do
  val="$(grep -E "^${key}=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs)"
  if [[ -z "$val" ]]; then
    MISSING+=("$key")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  error "The following required secrets are missing from .env:"
  for k in "${MISSING[@]}"; do
    error "  - $k"
  done
  echo ""
  error "Generate them with: openssl rand -hex 32"
  exit 1
fi

# Check ENCRYPTION_SECRET is at least 32 chars
ENC_LEN="$(grep -E "^ENCRYPTION_SECRET=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs | wc -c | tr -d ' ')"
if [[ "$ENC_LEN" -lt 32 ]]; then
  error "ENCRYPTION_SECRET is too short (${ENC_LEN} chars, need ≥32). Regenerate: openssl rand -hex 32"
  exit 1
fi

success "All required secrets are set."

# ── Warn on missing AI providers ─────────────────────────────────────────────

AI_KEYS=("ANTHROPIC_API_KEY" "OPENAI_API_KEY" "GEMINI_API_KEY" "GROQ_API_KEY" "MISTRAL_API_KEY")
HAS_AI=false
for key in "${AI_KEYS[@]}"; do
  val="$(grep -E "^${key}=" "$ENV_FILE" | cut -d= -f2- | tr -d '"' | xargs)"
  if [[ -n "$val" ]]; then
    HAS_AI=true
    break
  fi
done

if [[ "$HAS_AI" == false ]]; then
  warn "No AI provider key set. Add at least one to .env for the agent to work:"
  for k in "${AI_KEYS[@]}"; do warn "  $k="; done
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Plexo is ready to start${RESET}"
echo -e "${BOLD}══════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  Config:  ${CYAN}${ENV_FILE}${RESET}"

if [[ "$_VALIDATE_ONLY" == false ]]; then
  echo -e "  Domain:  ${CYAN}${PUBLIC_URL}${RESET}"
fi

echo ""
echo -e "  Next steps:"
echo -e "  ${BOLD}1.${RESET} Add at least one AI provider key to .env"
echo -e "  ${BOLD}2.${RESET} Set your Telegram bot token if using the Telegram channel"
echo -e "  ${BOLD}3.${RESET} ${BOLD}docker compose -f docker/compose.yml up -d${RESET}"
echo ""
echo -e "  ${YELLOW}Keep .env private. It contains all your secrets.${RESET}"
echo ""
