# Getting Started

Your first task in 5 minutes.

## Prerequisites

- Docker 24.0+ with Compose v2
- 2 GB RAM minimum (4 GB recommended)
- A domain name pointed at your server (optional for local dev)

## 1. Clone and install

```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
bash scripts/install.sh --domain=plexo.yourdomain.com
```

The install script generates all secrets (`POSTGRES_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_SECRET`) and writes them to `.env`. No manual secret generation needed.

For local development without a domain, run:

```bash
bash scripts/install.sh
```

## 2. Start the stack

```bash
docker compose up -d
```

This starts PostgreSQL, Valkey (Redis), MinIO, the API server, and the web dashboard. Migrations run automatically on first boot -- give it about 60 seconds.

For production with auto-TLS via Caddy:

```bash
docker compose --profile selfhosted up -d
```

## 3. Verify

```bash
curl -s http://localhost:3001/health | python3 -m json.tool
```

You should see `"status": "ok"` with postgres and redis both reporting healthy.

## 4. Open the dashboard

Navigate to `http://localhost:3000` (or `https://plexo.yourdomain.com` if you configured a domain).

The setup wizard walks you through creating your first workspace and connecting an AI provider.

## 5. Connect an AI provider

Go to **Settings > AI Providers** and add at least one:

- **Anthropic** -- API key from [console.anthropic.com](https://console.anthropic.com/settings/keys)
- **OpenAI** -- API key from [platform.openai.com](https://platform.openai.com/api-keys)
- **Ollama** -- Optional, requires `--profile gpu`. No key needed. Base URL: `http://ollama:11434`
- **DeepSeek, Groq, Mistral, Gemini** -- Add via their respective API keys

Click **Test** to confirm the provider is reachable.

## 6. Submit your first task

In the dashboard chat, type a task:

```
Research the top 5 PostgreSQL connection pooling strategies and summarize pros/cons of each
```

Plexo will plan the work, execute it autonomously, and deliver a structured result. You can watch the execution in real-time on the task detail page.

## 7. View results

Click the task in the sidebar to see:

- The execution plan (steps, dependencies, parallel waves)
- Tool calls made during execution
- The final deliverable with summary and work products
- Quality score from the independent judge model

## What next

- [Skills](skills.md) -- Install or create SKILL.md skills to extend agent capabilities
- [MCP](mcp.md) -- Connect external MCP servers or use Plexo as an MCP producer
- [A2A](a2a.md) -- Agent-to-Agent protocol for multi-agent orchestration
- [Memory](memory.md) -- Workspace Memory and Structured Context Language
- [Configuration](configuration.md) -- Full environment variable reference
- [Self-Hosting Guide](self-host.md) -- TLS, backups, updates, troubleshooting
