<div align="center">
  <h1>Plexo</h1>
  <p><strong>The open-source AI agent platform.</strong></p>
  <p>Autonomous task execution with persistent memory, intelligent model routing, and a self-extending extension system. Describe an objective — Plexo plans, executes, and delivers.</p>

  <a href="https://github.com/joeybuilt-official/plexo/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
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

A small cloud VM or a home server in that class handles it comfortably.

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

**Login-first by default.** A self-host install lands users on `/login` —
no marketing chrome, no getplexo.com landing page. Set
`PLEXO_MARKETING_ENABLED=true` only if you want to mirror the public
getplexo.com landing for your own brand at `/`. `/privacy` and `/terms`
stay reachable either way.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, React, Tailwind CSS |
| Backend | Node.js, TypeScript, Express, FastAPI (graph sidecar) |
| Relational DB | PostgreSQL + pgvector |
| Graph DB | FalkorDB (per-workspace Cypher graphs) |
| Knowledge Graph | graphiti-core (temporal extraction) |
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
    |           +--> Memory Store (pgvector + FalkorDB)
    |           +--> SCL Engine
    |           +--> Tool Registry / MCP Client
    |           +--> Extension Synthesizer
    |           +--> One-Way Door Approvals
    |
    +--> Knowledge Graph (per-workspace Cypher graphs)
    |       Task DAG · Conversation Threads · Memory Lifecycle
    |       Schema Registry · Observability · Backup/Restore
    v
AI Providers (BYOK: Anthropic, OpenAI, Google, DeepSeek, Groq, Ollama, +11 more)
```

## Knowledge Graph Platform

Plexo runs a shared graph backend ([FalkorDB](https://www.falkordb.com)) behind a [FastAPI](https://fastapi.tiangolo.com) sidecar that powers:

- **Memory lifecycle** — Episodic node tier transitions (hot → active → cold) and confidence decay run as bulk Cypher `SET` mutations
- **Task DAG execution** — Sprint task dependencies stored as `(:Task)-[:DEPENDS_ON]->(:Task)`; topological waves and critical-path queries run as native Cypher
- **Conversation threading** — Messages stored as `(:Message)-[:IN_SESSION]->(:Session)` with `(:Message)-[:NEXT]->(:Message)` sibling chain for O(1) traversal
- **Per-workspace isolation** — Each workspace owns a Cypher graph (`plexo:<workspace_id>`); multi-tenant via Redis-protocol namespacing
- **Schema registry** — Per-app YAML schemas validate every write; nightly cardinality reports flag drift
- **Observability + backup** — 1% sampled latency/lock-wait telemetry; nightly AOF/RDB snapshots with weekly off-host upload

See [`adr/0016-falkordb-platform-strategy.md`](adr/0016-falkordb-platform-strategy.md) for the full architecture.

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

## Built With

Plexo stands on the shoulders of incredible open-source work. Big thanks to:

- **[FalkorDB](https://www.falkordb.com)** ([repo](https://github.com/FalkorDB/FalkorDB)) — high-performance multi-tenant graph database (Redis-protocol, Cypher, native vector). The shared graph platform behind plexo's memory lifecycle, task DAG, and conversation threading.
- **[graphiti-core](https://github.com/getzep/graphiti)** by [Zep](https://www.getzep.com) — temporal knowledge graph framework for AI agents. Powers Episodic / Entity extraction over the FalkorDB backend.
- **[GraphRAG-SDK](https://github.com/FalkorDB/GraphRAG-SDK)** — agentic LLM workflows over FalkorDB (currently evaluating for plexo's planner).
- **[pgvector](https://github.com/pgvector/pgvector)** — open-source vector similarity search for Postgres. Powers plexo's HNSW-indexed embedding store.
- **[Drizzle ORM](https://orm.drizzle.team)** ([repo](https://github.com/drizzle-team/drizzle-orm)) — TypeScript SQL toolkit that doesn't get in your way.
- **[FastAPI](https://fastapi.tiangolo.com)** ([repo](https://github.com/fastapi/fastapi)) + **[Pydantic](https://docs.pydantic.dev)** ([repo](https://github.com/pydantic/pydantic)) — the graph sidecar's request boundary and schema validation.
- **[Next.js](https://nextjs.org)** + **[React](https://react.dev)** + **[Tailwind CSS](https://tailwindcss.com)** — frontend trio.
- **[Vercel AI SDK](https://sdk.vercel.ai)** ([repo](https://github.com/vercel/ai)) — provider-agnostic LLM streaming.
- **[Ollama](https://ollama.com)** ([repo](https://github.com/ollama/ollama)) — local-first inference for the embeddings sidecar.
- **[snowflake-arctic-embed](https://github.com/Snowflake-Labs/arctic-embed)** — the embedding model running inside the embeddings sidecar.
- **[Deepgram](https://deepgram.com)** — voice transcription (BYOK).
- **[Redis](https://redis.io)** / **[Valkey](https://valkey.io)** ([repo](https://github.com/valkey-io/valkey)) — task queue + sidecar transport.
- **[Inngest](https://www.inngest.com)** ([repo](https://github.com/inngest/inngest)) — durable workflow engine for memory + extract pipelines.
- **[pino](https://getpino.io)** ([repo](https://github.com/pinojs/pino)) — fast structured logging.
- **[pnpm](https://pnpm.io)** + **[Turborepo](https://turborepo.com)** ([repo](https://github.com/vercel/turbo)) — monorepo orchestration.
- **[vitest](https://vitest.dev)** ([repo](https://github.com/vitest-dev/vitest)) + **[Playwright](https://playwright.dev)** ([repo](https://github.com/microsoft/playwright)) — unit and end-to-end testing.
- **[MCP](https://modelcontextprotocol.io)** — the Model Context Protocol; plexo speaks MCP as both server and client.

If you build something on top of plexo, send a PR adding it to the [Extension Hub](https://hub.getplexo.com).

## Contributing

Plexo is open source under MIT. Contributions are welcome.

1. Fork the repository
2. Create your feature branch
3. Run tests: `pnpm test`
4. Open a Pull Request

## License

[MIT](LICENSE) — Use, modify, and self-host freely with attribution. The entire repository is MIT; there is no copyleft subtree. See [LICENSING.md](LICENSING.md).

---

<p align="center">A <a href="https://joeybuilt.com">Joeybuilt</a> product.</p>
