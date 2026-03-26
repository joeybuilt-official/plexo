# Self-Host Plexo

Get Plexo running on your own server in under 20 minutes.

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Docker | 24.0+ |
| Docker Compose | 2.20+ |
| RAM | 2 GB minimum |
| Domain | Pointed at your server's IP |

## 1. Clone and configure

```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
cp .env.example .env
```

Edit `.env` and set these 5 values:

```bash
# Generate secrets (copy-paste these commands):
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
echo "SESSION_SECRET=$(openssl rand -hex 64)" >> .env
echo "ENCRYPTION_SECRET=$(openssl rand -hex 32)" >> .env
echo "SUPABASE_JWT_SECRET=$(openssl rand -hex 32)" >> .env

# Set your domain:
echo "PUBLIC_URL=https://plexo.yourdomain.com" >> .env
echo "PUBLIC_DOMAIN=plexo.yourdomain.com" >> .env
```

AI provider keys are configured in-app after launch. No API key is needed to start.

## 2. Run

```bash
docker compose up -d
```

Expected output:
```
[+] Running 6/6
 ✔ Network plexo_default  Created
 ✔ Container postgres     Started
 ✔ Container redis        Started
 ✔ Container migrate      Started
 ✔ Container api          Started
 ✔ Container web          Started
```

## 3. Verify

Check that all services are healthy:

```bash
curl -s https://plexo.yourdomain.com/health | python3 -m json.tool
```

Expected response:
```json
{
    "status": "ok",
    "services": {
        "postgres": { "ok": true },
        "redis": { "ok": true }
    }
}
```

Open `https://plexo.yourdomain.com` in your browser. You should see the setup wizard.

## 4. Connect a model

In the setup wizard (or Settings > AI Providers after setup):

### Anthropic (recommended)
1. Get an API key at [console.anthropic.com](https://console.anthropic.com/settings/keys)
2. Paste it into the Anthropic provider field
3. Click Test — you should see "Provider is working"

### OpenAI
1. Get an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Paste it into the OpenAI provider field
3. Click Test

### Ollama (local, no API key)
1. Install Ollama: `curl -fsSL https://ollama.com/install.sh | sh`
2. Pull a model: `ollama pull llama3.2`
3. In Plexo, select Ollama as provider and set base URL to `http://host.docker.internal:11434`
4. Click Test

## Architecture

The stack runs 5 containers:

| Container | Port | Purpose |
|-----------|------|---------|
| `web` | 3000 | Next.js dashboard |
| `api` | 3001 | Express API + agent engine |
| `postgres` | 5432 | PostgreSQL 16 + pgvector |
| `redis` | 6379 | Valkey (queue state, slots) |
| `caddy` | 80/443 | Reverse proxy, auto-HTTPS |

## Updates

```bash
git pull
docker compose up -d --build
```

Migrations run automatically on startup.

## Backups

```bash
docker compose exec postgres pg_dump -U plexo plexo > backup-$(date +%Y%m%d).sql
```

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Can't reach dashboard | DNS pointing to server? `docker compose logs caddy` |
| 502 errors | `docker compose logs api` and `docker compose logs web` |
| Tasks fail immediately | Settings > AI Providers — is a provider configured and tested? |
| Agent health endpoint | `curl https://yourdomain.com/api/v1/agent/health` |
