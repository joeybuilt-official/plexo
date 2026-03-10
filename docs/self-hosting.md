# Self-Hosting Guide

## Prerequisites

- A server with Docker and Docker Compose (2GB RAM minimum)
- A domain name pointing to your server's IP
- 20 minutes

## Quick Start

```bash
git clone https://github.com/joeybuilt-official/plexo
cd plexo
cp .env.example .env
```

Edit `.env` and fill in 5 required values:

1. `POSTGRES_PASSWORD` — generate with `openssl rand -hex 32`
2. `PUBLIC_URL` — e.g. `https://plexo.yourdomain.com`
3. `PUBLIC_DOMAIN` — e.g. `plexo.yourdomain.com`
4. `SESSION_SECRET` — generate with `openssl rand -hex 64`
5. `ENCRYPTION_SECRET` — generate with `openssl rand -hex 32`

AI provider keys (OpenAI, OpenRouter, Groq, etc.) are configured in-app via **Settings → AI Providers** after first launch. No AI key is required to start.

Then start:

```bash
docker compose -f docker/compose.yml up -d
```

Open your domain in a browser. The setup wizard guides you through the rest.

## Architecture

The stack runs 5 containers:

| Container | Port | Description |
|-----------|------|-------------|
| `caddy` | 80, 443 | Reverse proxy with auto-HTTPS |
| `web` | 3000 | Next.js dashboard |
| `api` | 3001 | Express API server |
| `postgres` | 5432 | PostgreSQL 16 + pgvector |
| `redis` | 6379 | Valkey (Redis-compatible) |

## Health Check

```bash
curl https://plexo.yourdomain.com/health
```

## Updates

```bash
git pull
docker compose -f docker/compose.yml up -d --build
```

## Backups

Postgres data lives in a Docker volume. Back up with:

```bash
docker compose -f docker/compose.yml exec postgres pg_dump -U plexo plexo > backup.sql
```

## Troubleshooting

- **Can't reach the dashboard**: Is your domain DNS pointing to the server? Is Caddy running? Check `docker compose logs caddy`.
- **502 errors**: API or web container may not be healthy. Check `docker compose logs api` and `docker compose logs web`.
- **Auth issues**: Verify `AUTH_URL` and `AUTH_SECRET` match your `.env` values.
