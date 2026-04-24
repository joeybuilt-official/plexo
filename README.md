<div align="center">
  <h1>Plexo</h1>
  <p><strong>The open-source AI agent platform.</strong></p>
  <p>Autonomous task execution with persistent memory, intelligent model routing, and a self-extending extension system. Describe an objective — Plexo plans, executes, and delivers.</p>

  <a href="https://github.com/joeybuilt-official/plexo/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="License" /></a>
  <a href="https://github.com/joeybuilt-official/plexo/releases"><img src="https://img.shields.io/github/v/release/joeybuilt-official/plexo?label=version" alt="Version" /></a>
  <a href="https://hub.getplexo.com"><img src="https://img.shields.io/badge/Hub-marketplace-blueviolet" alt="Hub" /></a>
  <a href="https://getplexo.com"><img src="https://img.shields.io/badge/Cloud-getplexo.com-brightgreen" alt="Cloud" /></a>

  <p>
    <a href="https://getplexo.com"><strong>Cloud (Managed)</strong></a> ·
    <a href="#quick-start-self-host"><strong>Self-Host</strong></a> ·
    <a href="#features"><strong>Features</strong></a> ·
    <a href="https://hub.getplexo.com"><strong>Extension Hub</strong></a> ·
    <a href="https://github.com/joeybuilt-official/plexo/discussions"><strong>Community</strong></a>
  </p>
</div>

<!-- Screenshot: Full dashboard view showing a completed task with tool calls, the conversation sidebar, and the memory panel. Ideally 1200x700px, dark mode. -->

## Features

- **Intelligent Model Routing** — Configure a primary provider and fallback chain per task type. Per-model reliability scoring learns which providers work best. Supports 17+ providers including Anthropic, OpenAI, Google, DeepSeek, Groq, Ollama, and any OpenAI-compatible endpoint.
- **Semantic Context Lattice (SCL)** — A persistent knowledge graph built from completed tasks. Concepts extracted via LLM, embedded, stored in a Golden Record. Drift detection warns when domain patterns shift. Ghost archival removes stale concepts. [Learn more](https://getplexo.com#scl)
- **Persistent Memory** — Task outcomes, user instructions, and behavioral patterns stored with pgvector embeddings. Tiered storage (hot/active/cold). Semantic search via HNSW index. Per-agent namespaces with a shared cross-agent knowledge layer.
- **PEX Extension System** — Six extension types: Agents, Skills, Channels, Tools, Connectors, and MCP Servers. Browse and install from the [Extension Hub](https://hub.getplexo.com). Build your own with the PEX SDK. [Learn more](https://getplexo.com#pex)
- **Self-Extending Agent** — Request an integration that doesn't exist and the agent scrapes the API docs, generates a valid PEX extension, registers the connection UI, and activates it — within a single task.
- **Model Foundry** — Train custom models from your collected inference data. Fine-tune on your domain, deploy locally or to a provider.
- **Independent Quality Judge** — A separate model evaluates every task output. Ensemble mode runs multiple local judges via Ollama with weighted consensus.
- **One-Way Door Approvals** — Irreversible actions require human approval. Standing approvals for trusted operations. Configurable escalation timeout per workspace.
- **Project Decomposition (Sprints)** — Describe a project and Plexo decomposes it into parallel tasks with dependency-aware wave scheduling. Per-task branches, draft PRs, conflict detection, budget ceilings.
- **Multi-Channel Access** — Web dashboard, Telegram (text + voice), Slack, Discord, REST API, and embeddable widget.
- **BYOK** — Bring your own API keys. No vendor lock-in. Pay providers directly.

## Cloud vs Self-Host

| | Cloud | Self-Host |
|---|---|---|
| **Setup** | Sign up at [getplexo.com](https://getplexo.com) | `docker compose up -d` |
| **Infrastructure** | Managed for you | Your servers, your data |
| **Updates** | Automatic | Pull and restart |
| **Best for** | Getting started fast | Full control, air-gapped environments |

Both options have feature parity. The cloud version adds managed backups and zero-config TLS.

## Requirements (Self-Host)

| | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 vCPU | 4 vCPU |
| **RAM** | 4 GB | 8 GB |
| **Disk** | 20 GB | 40 GB |
| **OS** | Ubuntu 22.04+, Debian 12+ | Same |
| **Docker** | 24.0+ | Latest |
| **Docker Compose** | 2.20+ | Latest |

A $24/mo VPS (Hetzner CX32, DigitalOcean, etc.) handles it comfortably.

## Quick Start (Self-Host)

**One-liner:**
```bash
bash <(curl -sL https://raw.githubusercontent.com/joeybuilt-official/plexo/main/scripts/install.sh) --domain=plexo.yourdomain.com
```

**Manual:**
```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
cp .env.example .env    # configure your secrets
docker compose up -d
```

The setup wizard walks you through connecting an AI provider.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, React, Tailwind CSS |
| Backend | Node.js, TypeScript, Express |
| Database | PostgreSQL + pgvector |
| Cache / Queue | Redis / Valkey |
| ORM | Drizzle |
| AI SDK | Vercel AI SDK |
| Voice | Deepgram (BYOK) |
| Containerization | Docker Compose |
| Monorepo | Turborepo, pnpm |

## Architecture

```
Channels (Web, Telegram, Slack, Discord, API, Widget)
    |
    v
Task Queue (Redis/Valkey)
    |
    v
Planner --> Executor --> Quality Judge
    |           |
    |           +--> Memory Store (pgvector)
    |           +--> SCL Engine
    |           +--> Tool Registry / MCP Client
    |           +--> Extension Synthesizer
    |           +--> One-Way Door Approvals
    v
AI Providers (BYOK: Anthropic, OpenAI, Google, DeepSeek, Groq, Ollama, +11 more)
```

## Extension Hub

Browse and install community extensions at [hub.getplexo.com](https://hub.getplexo.com).

## Documentation

- [Getting Started](docs/getting-started.md) — First task in 5 minutes
- [Self-Hosting](docs/self-host.md) — Docker Compose setup, env vars, TLS
- [Skills](docs/skills.md) — Installing and creating SKILL.md skills
- [A2A](docs/a2a.md) — Connecting external A2A agents
- [MCP](docs/mcp.md) — MCP server and client usage
- [Memory](docs/memory.md) — SCL / Workspace Memory explanation
- [Analytics](ANALYTICS.md) — What telemetry is collected and how to opt out

## Contributing

Plexo is open source under AGPL-3.0. Contributions are welcome.

1. Fork the repository
2. Create your feature branch
3. Run tests: `pnpm test`
4. Open a Pull Request

## License

[AGPL-3.0](LICENSE) — You can use, modify, and self-host freely. If you modify Plexo and offer it as a network service, you must publish your modifications under the same license.

---

<p align="center">A <a href="https://joeybuilt.com">Joeybuilt</a> product.</p>
