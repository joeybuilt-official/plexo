# Self-Host Plexo

Get Plexo running on your own server in under 20 minutes.

## Prerequisites

| Requirement | Minimum |
|-------------|---------|
| Docker | 24.0+ |
| Docker Compose | v2 (ships with Docker Desktop and modern Docker Engine) |
| RAM | 2 GB (4 GB recommended) |
| Disk | 20 GB |
| OS | Any Linux distro, macOS, or WSL2 |

A domain name pointed at your server's IP is required for TLS. Without one, you can access Plexo on `http://localhost:3000` for local development.

## 1. Clone and configure

```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
```

**Option A -- Automated setup** (generates all secrets for you):

```bash
bash scripts/install.sh --domain=plexo.yourdomain.com
```

**Option B -- Manual setup:**

```bash
cp .env.example .env
```

Set these five required values in `.env`:

| Variable | How to generate | Purpose |
|----------|----------------|---------|
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` | Database credential |
| `SESSION_SECRET` | `openssl rand -hex 64` | Encrypts user sessions |
| `ENCRYPTION_SECRET` | `openssl rand -hex 32` | AES-256-GCM key for API credentials at rest |
| `PUBLIC_URL` | e.g. `https://plexo.yourdomain.com` | OAuth callbacks, external links |
| `PUBLIC_DOMAIN` | e.g. `plexo.yourdomain.com` | Caddy TLS, CORS |

Copy-paste secret generation:

```bash
sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
sed -i "s/^SESSION_SECRET=$/SESSION_SECRET=$(openssl rand -hex 64)/" .env
sed -i "s/^ENCRYPTION_SECRET=$/ENCRYPTION_SECRET=$(openssl rand -hex 32)/" .env
sed -i "s/^STORAGE_SECRET_KEY=$/STORAGE_SECRET_KEY=$(openssl rand -hex 32)/" .env
```

Then edit `PUBLIC_URL` and `PUBLIC_DOMAIN` to match your domain.

AI provider keys are **not** needed to start. You configure them in-app after launch.

See [configuration.md](configuration.md) for the full environment variable reference.

### Login-first home page

A self-host install ships login-first: visiting `/` redirects anonymous
visitors to `/login` and authenticated users to `/app`. There's no
public marketing chrome — the dashboard is the product.

Compliance routes (`/privacy`, `/terms`) stay reachable.

If you want to render a public landing page at `/` for your own brand
(mirroring the getplexo.com layout), set:

```env
PLEXO_MARKETING_ENABLED=true
```

The legacy flag `SKIP_LANDING=true` is still honored as a force-off.

## 2. Run

```bash
docker compose up -d
```

Expected output:

```
[+] Running 7/7
 ✔ Network plexo_default  Created
 ✔ Container postgres     Started
 ✔ Container redis        Started
 ✔ Container minio        Started
 ✔ Container migrate      Started
 ✔ Container api          Started
 ✔ Container web          Started
```

The `migrate` container runs database migrations and exits. The API waits for it to complete before starting.

First boot takes 1-2 minutes while containers build. Subsequent starts are instant.

## 3. Verify

```bash
# Health check (use localhost:3001 if no domain/proxy configured yet)
curl -s https://plexo.yourdomain.com/health | python3 -m json.tool
```

Expected:

```json
{
    "status": "ok",
    "services": {
        "postgres": { "ok": true },
        "redis": { "ok": true }
    }
}
```

Open `https://plexo.yourdomain.com` (or `http://localhost:3000` for local) in your browser. You should see the setup wizard.

## 4. Connect an AI provider

Navigate to **Settings > AI Providers** (or use the setup wizard on first launch). You need at least one provider for the agent to work.

### Anthropic (recommended)

1. Get an API key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
2. In Plexo, click **Add Provider > Anthropic**
3. Paste your key and click **Test** -- you should see "Provider is working"

### OpenAI

1. Get an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Add provider, paste key, click **Test**

### DeepSeek

1. Get an API key at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)
2. Add provider, select **DeepSeek**, paste key, click **Test**

### Ollama (optional -- GPU profile)

Ollama is not required. Plexo uses its built-in inference gateway for embeddings by default. If you have a GPU and want to run local LLMs via Ollama, start Plexo with the GPU profile:

```bash
docker compose --profile gpu up -d
```

To configure Ollama as a chat provider, go to **Settings > AI Providers**, add **Ollama**, and set the base URL to `http://ollama:11434` (the managed sidecar) or point it at an external Ollama instance.

> **Tip:** If using an external Ollama, check that `OLLAMA_HOST=0.0.0.0` is set so it listens on all interfaces.

## Architecture

The stack runs these containers:

| Container | Port | Purpose |
|-----------|------|---------|
| `web` | 3000 | Next.js dashboard |
| `api` | 3001 | Express API + agent engine |
| `postgres` | 5432 | PostgreSQL 16 + pgvector |
| `redis` | 6379 | Valkey (task queue, cache, pub/sub) |
| `minio` | 9000/9001 | S3-compatible asset storage |
| `inference-gateway` | 3001 (internal) | Native ONNX embeddings |
| `ollama` | 11434 (internal) | Local LLM + embeddings (gpu profile) |
| `caddy` | 80/443 | Reverse proxy with auto-TLS (selfhosted profile) |

Caddy is enabled with: `docker compose --profile selfhosted up -d`

## TLS

Caddy handles TLS automatically via Let's Encrypt. Requirements:

- Ports 80 and 443 open on your server
- Domain A record pointed to the server IP before starting
- **Cloudflare users:** Set SSL/TLS mode to "Full" (not "Full (strict)")

## Updates

```bash
git pull origin main
docker compose up -d --build
```

Migrations run automatically on every startup.

## Backups

```bash
# Database
docker compose exec postgres pg_dump -U plexo plexo > backup-$(date +%Y%m%d).sql

# Restore
cat backup-20260327.sql | docker compose exec -T postgres psql -U plexo plexo
```

| Volume | Contents | Risk if deleted |
|--------|----------|-----------------|
| `pgdata` | All Plexo data | **Permanent data loss** |
| `redisdata` | Cache + queue state | Low -- rebuilds automatically |
| `miniodata` | Agent-produced files | Medium -- generated assets lost |
| `caddy_data` | TLS certificates | Medium -- ACME rate limits apply |
| `ollama_models` | Ollama model weights (gpu profile) | Low -- re-pulled on next start |
| `generated_skills` | Auto-generated extensions | Low -- agent can regenerate |

## Troubleshooting

### Dashboard unreachable

- Verify DNS: `dig +short plexo.yourdomain.com` should return your server IP
- Check Caddy: `docker compose logs caddy`
- Without Caddy, access directly at `http://server-ip:3000`

### 502 Bad Gateway

```bash
docker compose logs api --tail 50
docker compose logs web --tail 50
```

The API takes ~30 seconds on first boot while migrations run.

### Database connection failures

```bash
docker compose logs postgres --tail 20
```

Common cause: `POSTGRES_PASSWORD` in `.env` changed after the volume was created. Fix: either use the original password or reset the volume:

```bash
docker compose down
docker volume rm plexo_pgdata  # WARNING: deletes all data
docker compose up -d
```

### Ollama not reachable (GPU profile)

If you started with `--profile gpu` and Ollama is unreachable:

1. Check container is running: `docker compose --profile gpu ps ollama`
2. Check logs: `docker compose --profile gpu logs ollama`
3. If using an external Ollama instead, confirm it's listening on all interfaces: `OLLAMA_HOST=0.0.0.0 ollama serve`
4. Use `http://172.17.0.1:11434` as the base URL if `host.docker.internal` doesn't resolve (common on Linux without Docker Desktop)

### Port conflicts

If port 3000 or 3001 is already in use, either stop the conflicting service or change the port mapping in `docker-compose.yml`:

```yaml
web:
  ports:
    - "8080:3000"  # access dashboard on port 8080 instead
```

### Tasks fail immediately

- Check that at least one AI provider is configured and tested in Settings > AI Providers
- Check the API logs: `docker compose logs api --tail 50`
- Verify the cost ceiling hasn't been reached: Settings > Cost Controls
