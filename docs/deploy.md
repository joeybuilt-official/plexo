# Plexo — Self-Hosted Deployment

Plexo ships as a Docker Compose stack. You need a Linux server with Docker installed.

## Requirements

| Component | Minimum | Recommended |
|---|---|---|
| RAM | 2 GB | 4 GB |
| CPU | 1 vCPU | 2 vCPU |
| Disk | 20 GB | 40 GB |
| Docker | 24+ | latest |
| OS | Ubuntu 22.04 / Debian 12+ | — |

> Any cloud provider (Hetzner, DigitalOcean, Linode, AWS EC2 t3.medium, etc.) at the above spec works.

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/joeybuilt-official/plexo
cd plexo

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in POSTGRES_PASSWORD, SESSION_SECRET, PUBLIC_URL,
# PUBLIC_DOMAIN, and generate ENCRYPTION_SECRET (openssl rand -hex 32)

# 3. Start
docker compose up -d

# 4. Smoke test
curl https://your-domain.com/health | jq .
```

On first start, the `migrate` service runs all database migrations automatically before the API comes up.

## Environment Variables

See `.env.example` for the full list with descriptions.

**Required:**
- `POSTGRES_PASSWORD` — generate with `openssl rand -hex 32`
- `SESSION_SECRET` — generate with `openssl rand -hex 64`
- `PUBLIC_URL` — full URL including protocol, e.g. `https://plexo.example.com`
- `PUBLIC_DOMAIN` — domain only, e.g. `plexo.example.com`
- `ENCRYPTION_SECRET` — generate with `openssl rand -hex 32`
- AI provider keys are configured in-app via **Settings → AI Providers** (not required at deploy time)

**Optional** (unlock features when set):
- `GITHUB_CLIENT_ID/SECRET` — GitHub login + GitHub Actions connection
- `SLACK_CLIENT_ID/SECRET` — Slack channel integration
- `TELEGRAM_BOT_TOKEN` — Telegram bot channel
- `DISCORD_APP_ID/PUBLIC_KEY/BOT_TOKEN` — Discord slash commands
- `GOOGLE_CLIENT_ID/SECRET` — Google Drive connection

## Platform-Specific Deployments (Coolify, Portainer)

When using a standard VPS, our `install.sh` script automatically generates cryptographically secure values for the required secrets (`POSTGRES_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_SECRET`), writes them to a `.env` file, and boots the stack.

However, when deploying via PaaS solutions like **Coolify** or **Portainer**, they parse the `docker-compose.yml` directly and detect the required environment variables, but they **will leave the values blank by default**.

If you attempt to boot without filling these out in the Coolify/Portainer Web UI:
1. `POSTGRES_PASSWORD` will be evaluated as blank.
2. The `postgres` container will refuse to start because it disables "trust" authentication by default for security, throwing `Error: Database is uninitialized and superuser password is not specified.`
3. Because Postgres never boots, the `migrate` container gets stuck in a loop trying to look up the host (`EAI_AGAIN postgres`) and eventually times out with an `exit 1`.
4. The deployment will be marked as "Failed".

**The Fix:** Before clicking "Deploy" in your PaaS dashboard, navigate to the Environment Variables tab for your project, find these keys, and manually populate them with secure random strings.


## TLS

Caddy handles TLS automatically via ACME (Let's Encrypt). Port 80 and 443 must be open on your server. Point your domain's A record to the server IP before starting.

> **Cloudflare users:** set SSL/TLS mode to "Full" (not "Full (strict)") or use Cloudflare's origin cert.

## Reverse Proxy Configuration

The included `docker/Caddyfile` routes:
- `/*` → web dashboard (Next.js, port 3000)
- `/api/*`, `/health` → API server (Express, port 3001)
- `/api/sse` → SSE stream (buffering disabled)
- `/api/auth/*` → Auth.js callbacks (web)

If you prefer nginx, point it at the same internal ports with equivalent proxy_pass and proxy_buffering off for SSE.

## Updates

```bash
git pull origin main
docker compose up -d --build
```

Migrations run automatically on restart via the `migrate` service.

## Rollback

Each git tag is a deployable version. To roll back:

```bash
git checkout v1.0.0            # target version
docker compose up -d --build
```

Database migrations are **additive only** — no columns are ever dropped in a patch release. Rolling back the code is always safe. Rolling back the DB schema requires manual intervention if you downgrade more than one minor version.

## Volumes

| Volume | Contents | Risk to delete |
|---|---|---|
| `pgdata` | All Plexo data | **Permanent data loss** |
| `redisdata` | Cache + session state | Low — rebuilds automatically |
| `caddy_data` | TLS certificates | Medium — ACME rate limits apply |
| `caddy_config` | Caddy config cache | None |

## Health Check

```bash
curl https://your-domain.com/health
```

```json
{
  "status": "ok",
  "services": {
    "postgres": { "ok": true, "latencyMs": 2 },
    "redis":    { "ok": true, "latencyMs": 1 }
  },
  "version": "1.2.0-dev",
  "fabric": { "complianceLevel": "full", "specVersion": "0.4.0", "host": "plexo" }
}
```

`status` is `"ok"` when all critical services (postgres, redis) are healthy. AI provider availability is non-critical — the agent degrades to queue-only mode if the provider is unreachable.
