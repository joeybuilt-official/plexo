<div align="center">
  <h1>Plexo</h1>
  <p><strong>The open-source AI agent platform.</strong></p>
  <p>Autonomous task execution with persistent memory, intelligent model routing, and a self-extending extension system. Describe an objective — Plexo plans, executes, judges, and remembers.</p>

  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT" /></a>
  <a href="https://github.com/joeybuilt-official/plexo/releases"><img src="https://img.shields.io/github/v/release/joeybuilt-official/plexo?label=SDK%20release" alt="SDK release" /></a>
  <a href="https://getplexo.com"><img src="https://img.shields.io/badge/Cloud-getplexo.com-brightgreen" alt="Cloud" /></a>

  <p>
    <a href="https://getplexo.com"><strong>Cloud (Managed)</strong></a> ·
    <a href="#quick-start-self-host"><strong>Self-Host</strong></a> ·
    <a href="#features"><strong>Features</strong></a> ·
    <a href="https://github.com/joeybuilt-official/plexo/discussions"><strong>Community</strong></a>
  </p>
</div>

Plexo is a self-hostable platform for running AI agents that actually execute work rather than only chatting with you. You give it an objective; a Postgres-backed queue claims it, a planner produces steps, an executor runs those steps with tools (shell, files, web, workspace, MCP, connectors), an independent judge scores the result, and the outcome is written to long-term memory. Bring your own model keys.

## Table of contents

- [Features](#features)
- [Cloud vs Self-Host](#cloud-vs-self-host)
- [Requirements](#requirements-self-host)
- [Quick start (self-host)](#quick-start-self-host)
- [Configuration](#configuration)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [Extensions](#extensions-pex)
- [Surfaces](#surfaces)
- [Development](#development)
- [Documentation](#documentation)
- [Known gaps](#known-gaps)
- [Contributing](#contributing)
- [License](#license)

## Features

**Agent execution core**
- Plan → execute → judge loop with a live step stream over SSE.
- Independent quality judge; ensemble mode runs multiple local Ollama judges with weighted consensus and caps unverified output.
- One-way-door approvals: irreversible and outbound actions pause the task until a human approves from the dashboard or CLI. Per-workspace escalation timeout.
- Mid-run steering, message injection and clarification requests against a running task.
- Code work in a cloned repository: SSH deploy key → shallow clone into an isolated temp dir → scope-file priming → file tree, content, diff and terminal panels in the workbench.
- Per-task isolated working directory, tool-output ceilings, side-effect checks, a per-task cost ceiling (workspace setting / `tasks.costCeilingUsd`) and a workspace-wide weekly spend ceiling (`API_COST_CEILING_USD`, default 10.00 in the installer).

**Model routing (BYOK)**
- 20 built-in provider keys — OpenRouter, Anthropic (including subscription), OpenAI, Google, Mistral, Groq, xAI, DeepSeek, Together, Fireworks, Perplexity, Cerebras, SambaNova, Cohere, Cloudflare, Ollama, Ollama Cloud, LiteLLM, fal — plus custom OpenAI-compatible endpoints.
- Per-task-type routing chains with fallback options, lane limiting, error classification, and reliability scoring learned from observed results.
- Managed Ollama sidecar (compose profile `local-llm`) for local inference.
- OpenAI-compatible inference proxy for trusted background apps, with per-app spend attribution.

**Memory**
- pgvector-backed entries with structured fact columns (fact type, subject/predicate/object, domain, scope, validity window, confidence, retrieval count).
- Hot / active / cold tiers with promotion on retrieval, eviction settings, confidence decay and consolidation.
- Per-agent namespaces plus a shared cross-agent layer; corrections, preferences, instruction detection, prompt-improvement proposals and a self-improvement cycle.
- Automatic extraction after each turn via Inngest durable functions.
- Semantic search runs when an OpenAI-compatible embeddings endpoint is reachable at `EMBEDDINGS_URL`; otherwise memory search falls back to keyword matching. No embeddings service is bundled.

**Extensions (PEX)**
- Five live extension types — `skill`, `channel`, `tool`, `connector`, `agent` — with a manifest and capability model, validated on install.
- Install, enable, disable, upgrade, uninstall, sideload, install-from-URL (SSRF-guarded allowlist), and a sandboxed persistent worker pool.
- Self-extending agent: `synthesize_extension` scrapes API docs, generates an ESM extension plus manifest under a capability allowlist, registers the connection UI, and activates it inside a single task.
- MCP as a **client** is fully wired (auto-discovery of an installed MCP server's tools). The bundled MCP **server** package exists but nothing starts it by default.

**Connections and integrations**
- Registry of 24 connections; 13 have real behaviour and 11 are explicit stubs (`stub: true` in `packages/agent/src/connections/registry.ts`) that return `[NOT YET IMPLEMENTED]`. Dedicated factories exist for `ssh`, `mcp`, `levio` and `google-workspace`.
- Credentials pasted into chat are detected, encrypted at rest (AES-256-GCM) and auto-installed as a connection.
- GitHub App webhook → executor tasks (push, pull_request, issues, issue_comment) with signature verification.
- Per-workspace inbound webhooks with HMAC and a 256 KB body cap.
- Local bridge nodes for desktop filesystem and shell devices.

**Operations**
- Postgres backup sidecar with interval and retention, Caddy automatic TLS under `--profile selfhosted`, memory limits on the long-running services, log rotation.
- Prometheus metrics, SLO and budget alerts, health monitor, error ring, onboarding canary, stabilization agents.
- Analytics with consent, sanitization and opt-out — see [ANALYTICS.md](ANALYTICS.md).
- Stripe billing is implemented but inert without `STRIPE_SECRET_KEY`.

## Cloud vs Self-Host

| | Cloud | Self-Host |
|---|---|---|
| **Setup** | Sign up at [getplexo.com](https://getplexo.com) | `scripts/install.sh --domain=…` (see the known issue below) |
| **Infrastructure** | Managed for you | Your servers, your data |
| **Updates** | Automatic | `git pull && docker compose up -d --build` |
| **Best for** | Getting started fast | Full control, air-gapped environments |

The managed cloud runs a separate private codebase with its own overlay on top of this repository — it is **not** feature-identical to the open-source tree. Everything documented in this README is what the OSS repository actually ships. See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSING.md](LICENSING.md).

## Requirements (Self-Host)

| | Minimum | Recommended |
|---|---|---|
| **CPU** | 2 vCPU | 4 vCPU |
| **RAM** | 2 GB | 8 GB |
| **Disk** | 20 GB | 40 GB |
| **OS** | Ubuntu 22.04+, Debian 12+ (Linux/macOS/WSL2 for development) | Same |
| **Docker** | 24.0+ | Latest |
| **Docker Compose** | v2.20+ | Latest |

Development additionally needs Node ≥ 22 and pnpm 10.30.3 (both pinned in `package.json`).

## Quick start (self-host)

**Installer** (generates secrets into `.env`, then brings the stack up behind Caddy with TLS):

```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
bash scripts/install.sh --domain=plexo.yourdomain.com
```

Or without cloning:

```bash
bash <(curl -sL https://raw.githubusercontent.com/joeybuilt-official/plexo/main/scripts/install.sh) --domain=plexo.yourdomain.com
```

`--domain` is required. Re-running the script regenerates `POSTGRES_PASSWORD`, which will not match an existing database volume — use `--force` only if you mean to start over.

> **Known issue: `install.sh` does not write `AUTH_DATABASE_URL`.** The script generates `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_SECRET`, `AUTH_SECRET`, the storage and Inngest keys, but not `AUTH_DATABASE_URL` — while `apps/api/src/env.ts` marks it required and `docker-compose.yml` passes it through with no default. As shipped, the API container exits 1 at boot and the installer's health check times out.
>
> After running the script, append `AUTH_DATABASE_URL` to `.env` and restart. Its value must be the in-network Postgres URL the API already uses: user `plexo`, the generated `POSTGRES_PASSWORD` from `.env`, host `plexo-db`, port `5432`, database `plexo` — the same string `docker-compose.yml` builds for `DATABASE_URL` on the `api` service. Then:
>
> ```bash
> docker compose --profile object-storage --profile selfhosted up -d
> ```
>
> Fixing this in `scripts/install.sh` is the right repair; until then, plan for the extra step.

**Manual.** `docker-compose.yml` interpolates several variables with no defaults, so `cp .env.example .env && docker compose up -d` does not boot a working stack on its own. Either run `install.sh` (plus the step above), or set at minimum:

```
POSTGRES_PASSWORD  REDIS_PASSWORD  SESSION_SECRET  ENCRYPTION_SECRET
AUTH_SECRET        AUTH_DATABASE_URL  PUBLIC_URL  PUBLIC_DOMAIN
STORAGE_ACCESS_KEY STORAGE_SECRET_KEY  INNGEST_SIGNING_KEY  INNGEST_EVENT_KEY
```

Neither `.env.example` nor `.env.full.example` contains `AUTH_DATABASE_URL`; it is only set in `docker-compose.e2e.yml`. Then:

```bash
docker compose --profile object-storage --profile selfhosted up -d --build
```

Profiles: `object-storage` starts MinIO (the API's default `STORAGE_ENDPOINT` points at it), `selfhosted` starts Caddy on 80/443, `local-llm` starts Ollama. Without `--profile selfhosted` the web and API containers publish no host ports. The one-shot `migrate` service applies Drizzle migrations before the API starts.

> **Fresh databases need one more step.** Migrations `0130`–`0143` are un-journaled hand-written SQL that drizzle-kit will not replay. Only `docker-compose.e2e.yml` sets `APPLY_ORPHANED_SQL=1`, so a fresh self-host install is missing those columns. Run `pnpm db:apply-orphaned` against the new database (or set `APPLY_ORPHANED_SQL=1` on the `migrate` service).

The setup wizard then walks you through connecting an AI provider: open your domain → create your account → Settings ▸ AI Models ▸ add provider → Test → run your first task.

**Login-first by default.** A self-host install lands users on `/login` — no marketing chrome. Set `PLEXO_MARKETING_ENABLED=true` only if you want to mirror the public landing page for your own brand at `/`. `/privacy` and `/terms` stay reachable either way.

**Updates:**

```bash
git pull origin main && docker compose up -d --build
```

Migrations re-run automatically through the `migrate` service. Roll back with `git checkout <tag> && docker compose up -d --build`.

## Configuration

`apps/api/src/env.ts` validates the environment at boot and exits 1 if a required variable is missing: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET` (≥32 chars), `ENCRYPTION_SECRET` (≥32), `AUTH_DATABASE_URL`, `AUTH_SECRET` (≥20).

Everything else is optional with a safe default. `.env.full.example` and [docs/configuration.md](docs/configuration.md) are the reference. Worth knowing:

- AI provider keys are BYOK and can be added in-app under Settings ▸ AI Models instead of via env.
- `EMBEDDINGS_URL` defaults to `http://embeddings:3001`, a service this compose file does not define. Point it at any OpenAI-compatible `/v1/embeddings` endpoint to get semantic memory search; leave it unset and memory search falls back to keywords.
- `API_COST_CEILING_USD`, `MAX_SPRINT_WORKERS`, `DATA_RETENTION_DAYS`, `ALLOW_SIDELOAD` (default false), `DOCKER_SOCKET_ENABLED` (default false, needed for one-click self-update).
- `ENABLE_SPRINT_CODING_TASKS` is documented in `.env.full.example` as unsafe when enabled; nothing in the current codebase reads it.
- `STRIPE_SECRET_KEY` — billing returns 503 without it.
- `SUPER_ADMIN_EMAILS` — an email allowlist, not a database role, gates the admin and debug surfaces. (`/federation` is not behind it; its endpoints use node auth instead.)

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 16, React 19, Tailwind CSS 4 |
| Backend | Node.js ≥22, TypeScript, Express 5 |
| Relational DB | PostgreSQL 16 + pgvector |
| Cache / Queue | Redis / Valkey |
| Durable functions | Inngest (bundled, Postgres-backed) |
| Object storage | MinIO (S3 API) |
| ORM | Drizzle (custom two-pass migrator in `packages/db/src/migrate.ts`) |
| AI SDK | Vercel AI SDK (`ai@^6`) |
| Auth | Better Auth |
| Voice | Deepgram (BYOK) |
| Edge / TLS | Caddy |
| Containerization | Docker Compose |
| Monorepo | Turborepo + pnpm workspaces |
| Clients | Flutter (Android), Electron connect-shell, commander CLI |

Memory is **Postgres-only**. A FalkorDB/graphiti knowledge-graph backend was retired on 2026-06-27 — see [MIGRATING.md](MIGRATING.md). `services/graphiti-sidecar/` is still in the tree and still built in CI, but nothing in the shipped stack calls it.

## Architecture

```
Channels (Web chat · embeddable widget · REST · CLI · MCP client · A2A · GitHub webhook)
    │
    ▼
Task Queue (Postgres-backed, Redis slot leases + heartbeats)
    │
    ▼
Planner ──► Executor ──► Quality Judge
               │
               ├──► Memory (pgvector: tiers, namespaces, consolidation)
               ├──► Tool Registry / MCP Client / Connections
               ├──► Extension runtime (sandboxed worker pool)
               ├──► Extension Synthesizer
               └──► One-Way Door Approvals
    │
    ▼
Provider Router (BYOK chains, fallbacks, reliability scoring)
```

Monorepo layout:

| Path | Contents |
|---|---|
| `apps/api` | Express API, agent loop, routes, repositories, middleware |
| `apps/web` | Next.js dashboard |
| `apps/cli` | `plexo` CLI (commander) |
| `apps/mobile` | Flutter Android client |
| `apps/desktop` | Electron connect-shell |
| `packages/agent` | Planner, executor, quality judge, memory, provider routing, plugin runtime |
| `packages/db` | Drizzle schema and migrator |
| `packages/queue` | Postgres task queue + Inngest functions |
| `packages/session-fabric` | Framework-free multi-actor session and runner policy |
| `packages/{auth,domain,logger,storage,sdk,ui,mcp-server}` | Supporting packages |
| `extensions/core/*` | Bundled PEX extensions |
| `docker/` | Dockerfiles, Caddyfile, runner jail, compose copy |
| `tests/` | unit, integration, e2e, load, chaos |

Dependency direction is enforced mechanically: `.dependency-cruiser.js` carries 15 rules (domain, session-fabric, sdk, logger, storage, queue, auth and db may not import outward; agent core may not import the ORM; API domain/application/routes may not import Drizzle; plus `not-circular`), run as `pnpm arch:check` against a committed ratchet baseline. Ten violations are baselined and tracked, not hidden: seven `agent-core-imports-orm`, one `api-routes-imports-drizzle`, and two import cycles (`packages/db` schema ↔ session-fabric schema, and an SDK type-only cycle).

## Extensions (PEX)

An extension is a package with a `plexo.json` manifest declaring its type, capabilities and configuration schema. Manifest validation, host-level gating and capability tokens live in `packages/sdk` (published as `@joeybuilt/plexo-sdk`, spec v0.4.0).

Install paths: from a manifest, from a URL (github/raw/gist/npmjs allowlist with private-IP blocking), from a SKILL.md skill file (see [docs/skills.md](docs/skills.md)), or sideloaded when `ALLOW_SIDELOAD=true`. Extensions run in a sandboxed persistent worker pool.

Bundled in `extensions/core/`: `fonto-bridge`, `fylo-bridge`, `koforje-bridge`, `levio-bridge`, `nexalog-bridge`, `research-agent`. The remaining directories (`cron-manager`, `devops-skill`, `github-ops`, `product-skill`, `research-skill`, `slack-channel`, `telegram-channel`) are package.json-only stubs with no implementation.

There is no extension marketplace shipped in this repository — no bundled catalog UI. The plumbing for one exists (`routes/registry.ts` mounted at `/api/v1/registry`, an `extension_registry` table, and the agent's `browse_hub` / `install_extension` tools), so install is by manifest, URL, sideload, or by asking the agent to synthesize an extension.

## Surfaces

- **Web dashboard** — Home, Conversations, Tasks, Memory, AI Models, Your Agent, Live Agents, Extensions, Connections, Settings, Logs, App Grants, Debug; plus `/app/chat`, `/app/workbench`, `/app/intelligence`, `/app/agents/live`.
- **Embeddable widget** — `GET /api/v1/chat/widget.js` returns a self-contained script; `/embed/{type}` serves iframe panels.
- **REST API** — mounted in `apps/api/src/index.ts`, prefix `/api/v1` with unversioned aliases; 82 route modules under `apps/api/src/routes/`, 77 of them imported by the server. `apps/api/openapi.yaml` describes only 11 paths — a stub, not the full surface.
- **CLI** — `apps/cli` (`@plexo/cli`, not published to npm — build and run from source): `auth`, `task {run,list,get,logs,cancel,block,approve}`, `connection`, `extension`, `memory`, `logs`, `status`, `config`, `pax`, `doctor`, `sessions`, `presence`, `attach`, `drive`, `run`, `approve`, `deny`.
- **MCP client** — consume external MCP servers as tools.
- **A2A** — `/.well-known/agent.json`, `/api/v1/a2a/agents`, `/api/v1/a2a/:agentId/tasks`.
- **Mobile** — Flutter thin client for Android (7 screens). Built by Codemagic on `v*` tags. No iOS platform files in this repository.
- **Desktop** — Electron connect-shell that pairs a local device as a bridge node.
- **Public share links** — `/s/{shareId}` for artifacts.

Channels: **web chat and the embeddable widget are the working inbound channels.** `apps/api/src/routes/telegram.ts` is present but not mounted in `index.ts`, so its inbound webhook path 404s; Slack and Discord route files were removed and only outbound delivery helpers remain. Gmail polling code exists and is unit-tested but has no channel routes attached.

## Development

```bash
pnpm install --frozen-lockfile

# local services (compose publishes no host ports by default — use your own
# Postgres+pgvector and Redis, or docker/compose.override.yml for an audit setup)
pnpm db:migrate
pnpm db:apply-orphaned      # un-journaled hand-written SQL (0130+)
pnpm dev                    # turbo dev → api :3001, web :3000
```

The API fails fast without the six required env vars. `apps/web` proxies `/api/*` to `INTERNAL_API_URL` (default `http://localhost:3001`).

```bash
pnpm test               # turbo test — per-package vitest
pnpm test:unit          # root unit suite
pnpm test:integration   # needs real Postgres+pgvector and Redis, migrated schema
pnpm test:e2e           # Playwright against a RUNNING stack
pnpm e2e:up && pnpm e2e:test && pnpm e2e:down   # ephemeral compose stack
bash scripts/test-fresh-db.sh                   # full migration chain on a throwaway DB

pnpm typecheck
pnpm lint
pnpm format / format:check
pnpm arch:check         # dependency-cruiser against the committed baseline
pnpm check:sql-arrays
sh scripts/sync-agents.sh --check
sh scripts/check-doc-refs.sh
pnpm --filter @plexo/db db:check-drift
```

283 test files: `packages/agent` 109, `apps/api` 93, `tests/e2e` 28, `tests/integration` 19, `apps/web` 12, `packages/session-fabric` 8. Integration tests run in CI against real Postgres and Redis with a per-run isolated database. Most E2E specs never run in CI — the only ones that do are `responsive-visual` and `a11y`, via `visual-regression.yml`, which is explicitly informational and not a required check.

CI (`.github/workflows/ci.yml`) runs typecheck, lint, arch, db-drift, docker-build, the graphiti sidecar probe, unit tests and integration tests — all on **self-hosted runners**, which do not run for pull requests from forks. The one gate a fork PR does get is `changelog-check.yml` (GitHub-hosted, SDK changes only). Run the gates locally and say so in the PR.

Notes: `prebuild` runs `sync-compose` (copies `docker-compose.yml` → `docker/compose.yml`), so a dirty diff there after a build is expected. Install fails if `patches/` is missing — `sharp@0.35.0` is patched. Commits must be signed off (`git commit -s`, DCO).

## Documentation

- [Getting Started](docs/getting-started.md) — first task
- [Self-Hosting](docs/self-host.md) — Compose setup, env vars, TLS
- [Configuration](docs/configuration.md) — full env reference
- [Skills](docs/skills.md) — installing and creating SKILL.md skills
- [Plugin SDK](docs/plugin-sdk.md) and [PEX spec](docs/pex/) — building extensions
- [Memory](docs/memory.md) — workspace memory model
- [MCP](docs/mcp.md) — server and client usage
- [A2A](docs/a2a.md) — connecting external agents
- [FAQ](docs/faq.md)
- [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md) · [MIGRATING.md](MIGRATING.md) · [ANALYTICS.md](ANALYTICS.md) · [LICENSING.md](LICENSING.md)

## Known gaps

Stated plainly, because the previous version of this README described infrastructure that no longer exists:

- **No knowledge graph.** FalkorDB and the graphiti memory backend were retired 2026-06-27 (see [MIGRATING.md](MIGRATING.md)). The root `docker-compose.yml` has neither service and no TypeScript code calls the sidecar. The sidecar source (`services/graphiti-sidecar/`) and a stale `docker/compose.yml` copy that still lists them survive, but `prebuild` regenerates that copy from the root file, so it will lose them on the next build.
- **No Model Foundry.** `foundry_models`, `foundry_shadow_results` and `foundry_training_runs` exist as tables with no readers or writers. The only live piece is read-only training-data export for super-admins.
- **No sprint decomposition.** The sprint orchestrator was deleted; there is no sprints router and no projects page. Tables and a repository file remain.
- **No Semantic Context Lattice.** Its tables were dropped; a settings toggle and an eval harness remain.
- **No bundled embeddings service**, so semantic memory search is keyword search until you supply an `EMBEDDINGS_URL`.
- **Telegram, Slack, Discord and other channels are not usable inbound.** Web chat and the widget only.
- **`plexo cron` does not work** — the CLI targets `/api/v1/cron`, which is not mounted. Internal cron jobs still run on their schedules, but there is no API, UI or CLI to manage them.
- **11 of 24 registry connections are stubs** returning `[NOT YET IMPLEMENTED]`.
- **Seven bundled extension directories are empty stubs.**
- **`docker-compose.gpu.yml` is an empty file** left behind after the vision sidecar was removed. Do not expect a GPU profile.
- **Fresh self-host installs may miss un-journaled migrations.** The compose `migrate` service does not set `APPLY_ORPHANED_SQL=1`; only the e2e stack does. Run `pnpm db:apply-orphaned` against a new database.
- **`install.sh` omits `AUTH_DATABASE_URL`**, so the documented install does not boot without a manual addition (see [Quick start](#quick-start-self-host)).
- **`openapi.yaml` covers 11 paths of the 77 mounted route modules.**
- Screenshots in `images/` were captured against a populated instance rather than seeded demo data, so they are not used in this README.
- The `local-llm` compose profile reserves 6 GB for Ollama alone — the RAM figures in [Requirements](#requirements-self-host) are for the base stack without it.

`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `CONVENTIONS.md`, `.claude/`, `.cursor/`, `.windsurf/` and `.clinerules/` are configuration for AI coding agents working in this repository; `.phalanx-automerge/` is an automerge marker and `.pushd.yaml` is a CI vendor build file. None of them are user documentation.

## Built with

Plexo builds on: [pgvector](https://github.com/pgvector/pgvector) · [Drizzle ORM](https://orm.drizzle.team) · [Next.js](https://nextjs.org) · [React](https://react.dev) · [Tailwind CSS](https://tailwindcss.com) · [Express](https://expressjs.com) · [Vercel AI SDK](https://sdk.vercel.ai) · [Better Auth](https://www.better-auth.com) · [Inngest](https://www.inngest.com) · [Ollama](https://ollama.com) · [Deepgram](https://deepgram.com) · [MinIO](https://min.io) · [Caddy](https://caddyserver.com) · [Redis](https://redis.io) / [Valkey](https://valkey.io) · [pino](https://getpino.io) · [pnpm](https://pnpm.io) + [Turborepo](https://turborepo.com) · [vitest](https://vitest.dev) + [Playwright](https://playwright.dev) · [MCP](https://modelcontextprotocol.io) · [Flutter](https://flutter.dev) · [Electron](https://www.electronjs.org).

## Contributing

Plexo is open source under MIT. Contributions are welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, commit format, ship gate and DCO sign-off rules.

1. Fork the repository and create a feature branch.
2. Run the gates locally: `pnpm test`, `pnpm typecheck`, `pnpm arch:check`, `pnpm build`.
3. Sign off your commits (`git commit -s`).
4. Open a pull request. CI does not run for forks.

Report vulnerabilities per [SECURITY.md](SECURITY.md) — do not open a public issue.

## License

[MIT](LICENSE) — Copyright (c) 2026 Joeybuilt LLC. Use, modify, distribute and self-host freely, provided the copyright and permission notices are retained.

The entire repository is MIT — every app, package, extension and service. There is no copyleft subtree and no dual-licensing arrangement. See [LICENSING.md](LICENSING.md).

---

<p align="center">A <a href="https://joeybuilt.com">Joeybuilt</a> product.</p>
