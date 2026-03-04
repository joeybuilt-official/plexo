<div align="center">

# Plexo

**An AI agent that works for you, 24/7, on your own server.**

Plexo runs a persistent agent that handles real work autonomously — and interrupts only when a real decision is needed. It communicates through channels you already use: Telegram, Slack, Discord. It learns from every task it completes. It is extensible via the **Kapsel** plugin standard.

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-orange.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/self--hosted-Docker-2496ED?logo=docker&logoColor=white)](docker/compose.yml)
[![Build](https://img.shields.io/badge/typecheck-passing-brightgreen)](https://github.com/dustin-olenslager/plexo)
[![Phase](https://img.shields.io/badge/phase-25%20complete-brightgreen)](https://github.com/dustin-olenslager/plexo#roadmap)
[![Kapsel](https://img.shields.io/badge/Kapsel-Full%20compliant-6C47FF)](https://github.com/joeybuilt-official/kapsel)

[**Managed hosting →**](https://getplexo.com) · [Docs](docs/) · [Kapsel SDK](packages/sdk/) · [Kapsel Protocol →](https://github.com/joeybuilt-official/kapsel) · [Architecture](docs/architecture.md)

</div>

---

## Not just for developers

Most AI tools are chat interfaces. You ask. They answer. You still do the work.

Plexo inverts that. You describe what you want — in a Telegram message, a Slack thread, or the dashboard — and the agent handles it end to end. It plans the work, executes it step by step, verifies each step actually worked, and tells you when it's done.

**This is for anyone who wants AI doing real work for them.**

A founder monitoring Stripe and generating weekly reports, an operator managing deployments and alerts, a researcher tracking topics and synthesizing sources, a developer running parallel code sprints — these are equally first-class use cases.

---

## What it handles

| | |
|---|---|
| **Development** | Write code, open PRs, run parallel code sprints, manage deployments, fix failing builds automatically |
| **Business ops** | Monitor Stripe, PostHog, Linear — generate reports, track KPIs, send scheduled updates |
| **Research** | Sourced answers, topic tracking, document synthesis, structured option comparisons |
| **Online tasks** | Web interaction, form automation, data collection, API-driven workflows |
| **Personal automation** | Recurring scheduled tasks, monitoring with notifications, custom workflows via extensions |

---

## Self-host in under 20 minutes

```bash
git clone https://github.com/dustin-olenslager/plexo
cd plexo
cp .env.example .env.local   # fill in 5 values
docker compose -f docker/compose.yml up -d
```

Open your domain. A browser wizard handles the rest — admin account, AI key, messaging channel, agent personality, launch. No terminal after that.

<details>
<summary><strong>The 5 values you need</strong></summary>

```bash
DATABASE_URL=postgresql://...     # or leave blank to use the bundled Postgres
REDIS_URL=redis://...             # or leave blank to use the bundled Redis
ANTHROPIC_API_KEY=sk-ant-...      # or connect via Claude.ai OAuth — no API key needed
PUBLIC_URL=https://your-domain    # where Plexo is reachable from the internet
SESSION_SECRET=any-random-string  # generate: openssl rand -hex 64
```

</details>

---

## Anthropic auth — API key or Claude.ai OAuth

Plexo supports both:

**API key** — paste a key from [console.anthropic.com](https://console.anthropic.com). Standard pay-per-token billing.

**Claude.ai OAuth (Pro/Max subscription)** — connect your Claude.ai account instead of buying API credits. Uses the same PKCE OAuth flow as Claude's own apps. No API key needed. Tokens are stored encrypted, auto-refreshed before expiry.

---

## Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| **Runtime** | Node.js ≥22, TypeScript strict | Native ESM, built-in crypto, no transpile overhead |
| **Web** | Next.js 15 App Router, Tailwind CSS | Server components, streaming, proven at scale |
| **API** | Express 5 | Async middleware native, vast ecosystem, simple mental model |
| **Database** | PostgreSQL 16 + pgvector 0.8.2, Drizzle ORM | Vector search native, no binary deps, SQL-native |
| **Cache / queue** | Redis (Valkey-compatible) | PKCE state, task queue, session cache, extension storage |
| **Auth** | Auth.js v5 (NextAuth) | Credential + OAuth providers, session management |
| **AI** | Vercel AI SDK — Anthropic, OpenAI, Google, Mistral, Groq, xAI, DeepSeek, Ollama, OpenRouter | Unified API, structured output, provider fallback chains |
| **Build** | pnpm workspaces + Turborepo | Incremental builds, workspace dependency graph |
| **Infra** | Docker Compose, Caddy reverse proxy | Self-hosting-first, automatic HTTPS |
| **Testing** | Vitest (unit + integration), Playwright (E2E) | Fast, ESM-native, first-class TypeScript |

---

## Monorepo layout

```
plexo/
├── apps/
│   ├── api/          Express 5 — agent loop, task/sprint APIs, channel adapters, SSE, registry
│   └── web/          Next.js 15 — dashboard, auth, settings, approvals UI
├── packages/
│   ├── agent/        Planner + Executor, provider registry, persistent worker pool, event bus
│   ├── db/           Drizzle schema, migrations, lazy client
│   ├── queue/        Task queue (push/list/complete/block/cancel)
│   └── sdk/          Public Kapsel plugin API (stable interface — semver enforced)
├── plugins/
│   └── core/         Built-in tools (read_file, write_file, shell, task_complete)
├── docker/           Compose files, Caddy config
├── docs/             Architecture, plugin SDK guide, deployment
└── tests/
    ├── unit/         Vitest unit tests (no network, no DB)
    └── integration/  Vitest integration tests (real Postgres)
```

---

## Execution protocol

The agent runs in a tight loop: **plan → execute → verify → report**.

```
User message
  └─▶ Planner (AI SDK generateObject)   generates ExecutionPlan JSON via Zod schema
        └─▶ Executor (AI SDK generateText + tools)
              ├─▶ read_file      read any file in scope
              ├─▶ write_file     write/patch files
              ├─▶ shell          run commands (sandboxed)
              ├─▶ [extension tools loaded from persistent workers]
              └─▶ task_complete  persist outcome, score quality, notify channel
```

Safety limits (hardcoded, not configurable):

| Limit | Default |
|-------|---------| 
| Max steps per task | 50 |
| Wall clock time | 30 minutes |
| Consecutive tool calls | 10 |
| API cost ceiling | $10 / task (env override) |
| No credentials in logs | Always |
| One-way door approval required | Schema migrations, public API changes, destructive ops |

One-way door operations require explicit approval via channel or dashboard before execution. The approval request appears in real time via SSE — no polling required.

---

## Kapsel — the extension standard powering Plexo

[**Kapsel**](https://github.com/joeybuilt-official/kapsel) is an open protocol for building AI agent extensions. It defines how an extension activates, what capabilities it can request, how it communicates with its host, and how it is packaged and distributed.

Think of it as the **App Store model for AI agents** — but open, self-hostable, and host-agnostic. An extension written once for Kapsel runs on any compliant host, not just Plexo.

**What makes Kapsel different:**

- **Capability-gated** — extensions declare exactly what they need (`storage:write`, `memory:read`, `connections:github`). The host enforces it. No extension gets access it didn't ask for.
- **Sandboxed by design** — extensions never import host internals. They get a typed SDK handle, nothing else. All host-side work happens in the host process; the extension just calls `sdk.*`.
- **Persistent workers** — one worker thread per extension, activated once, reused across all tool calls. No cold-start overhead on every invocation.
- **Cross-host portable** — the `kapsel.json` manifest and `activate(sdk)` entrypoint are the spec. Extensions don't care whether they're running in Plexo or any other compliant host.

Plexo ships with `@plexo/sdk` — a full Kapsel host implementation bundled directly in the repo. Plexo is **Kapsel Full compliant** at spec v0.2.0.

→ [Read the Kapsel Protocol Spec](https://github.com/joeybuilt-official/kapsel) · [Browse the Plexo SDK](packages/sdk/)

---

## Kapsel Extension System

Plexo is **Kapsel Full compliant** (spec v0.2.0). Extensions run in isolated persistent worker threads and communicate with the host through a capability-gated SDK.

```ts
// kapsel.json
{
  "name": "@acme/stripe-reporter",
  "version": "1.0.0",
  "kapselVersion": "^0.2.0",
  "capabilities": ["storage:read", "storage:write", "memory:write"]
}

// index.ts
import type { KapselSDK } from '@plexo/sdk'

export async function activate(sdk: KapselSDK) {
  sdk.registerTool({
    name: 'stripe_report',
    description: 'Generate a Stripe MRR report',
    parameters: { ... },
    handler: async ({ from, to }, ctx) => {
      const apiKey = await sdk.storage.get('stripe_key')
      const data = await fetchStripe(apiKey, from, to)
      await sdk.memory.write({ content: `MRR report ${from}→${to}: ${data.mrr}` })
      return data
    },
  })
}
```

**What extensions can do:**

| Capability | Token | What it enables |
|---|---|---|
| Storage | `storage:read` / `storage:write` | Per-extension Redis key-value store, 30-day TTL |
| Memory | `memory:read` / `memory:write` | Read/write workspace semantic memory (pgvector) |
| Connections | `connections:<service>` | Access credentials for installed OAuth connections |
| Tasks | `tasks:create` / `tasks:read` | Create and monitor tasks in the workspace queue |
| Events | `events:publish` / `events:subscribe` | Publish to `ext.<scope>.*` namespace on the event bus |
| UI | `ui:notify` | Push notifications to dashboard SSE clients |

**Sandbox isolation:** Every extension runs in its own persistent `worker_threads` Worker. The worker activates once and handles all subsequent tool calls — no per-call spawning overhead. Crashes are caught, the worker is respawned, and `sys.extension.crashed` is emitted on the event bus.

**Install an extension:**

```bash
POST /api/v1/plugins
{
  "source": "local",
  "path": "/path/to/extension",
  "enabled": true
}
```

---

## Kapsel Registry

The internal registry lets workspaces publish and discover extensions.

```
GET    /api/v1/registry              Search extensions (query, tag, publisher)
GET    /api/v1/registry/:name        Extension detail + full manifest
POST   /api/v1/registry              Publish or update an extension (requires auth)
DELETE /api/v1/registry/:name        Deprecate (hides from search, preserves history)
```

Published extensions are validated against the Kapsel manifest schema and a SHA-256 checksum is auto-generated. Publisher ownership is enforced — only the original publisher can update or deprecate.

---

## Channel adapters

| Channel | Status | Notes |
|---------|--------|-------|
| **Telegram** | ✅ | Webhook, secret validation, message→task, chat reply |
| **Slack** | ✅ | Events API, HMAC signature verification, message→task, thread reply |
| **Discord** | ✅ | Interactions API, Ed25519 verification, /task slash command |
| **Dashboard** | ✅ | QuickSend widget, task feed, live cards, real-time OWD approval banner |
| **API** | ✅ | REST — `POST /api/tasks` |

---

## API surface

All routes require a valid `workspaceId` UUID.

```
GET    /health                               Postgres + Redis latency, version, uptime, active workers
GET    /api/v1/tasks                         List tasks (paginated, filter by status/type/projectId)
POST   /api/v1/tasks                         Create task
GET    /api/v1/tasks/:id                     Task detail + execution steps
DELETE /api/v1/tasks/:id                     Cancel task
GET    /api/v1/tasks/stats/summary           Counts by status + cost totals
GET    /api/v1/sprints                       List sprints/projects
POST   /api/v1/sprints                       Create sprint
GET    /api/v1/sprints/:id                   Sprint detail + linked tasks
PATCH  /api/v1/sprints/:id                   Update status
GET    /api/v1/dashboard/summary             All dashboard card data (one request)
GET    /api/v1/dashboard/activity            Recent task feed
GET    /api/v1/workspaces                    List workspaces
POST   /api/v1/workspaces                    Create workspace
PATCH  /api/v1/workspaces/:id                Update workspace (deep-merges settings)
GET    /api/v1/workspaces/:id/members        List members
POST   /api/v1/workspaces/:id/members        Add member
PATCH  /api/v1/workspaces/:id/members/:mid   Change role
DELETE /api/v1/workspaces/:id/members/:mid   Remove member
POST   /api/v1/invites                       Create invite link
POST   /api/v1/invites/:token/accept         Accept invite
GET    /api/v1/approvals                     List pending one-way door decisions
POST   /api/v1/approvals/:id/approve         Approve a destructive operation
POST   /api/v1/approvals/:id/reject          Reject
GET    /api/v1/plugins                       List installed extensions
POST   /api/v1/plugins                       Install extension
PATCH  /api/v1/plugins/:id                   Enable/disable
DELETE /api/v1/plugins/:id                   Uninstall (terminates persistent worker)
GET    /api/v1/registry                      Search public extension registry
GET    /api/v1/registry/:name                Extension detail
POST   /api/v1/registry                      Publish extension (auth required)
DELETE /api/v1/registry/:name                Deprecate extension (auth required)
GET    /api/v1/memory/search                 Semantic memory search (pgvector + ILIKE fallback)
GET    /api/v1/memory/preferences            Workspace learned preferences
GET    /api/v1/connections                   List installed service connections
GET    /api/v1/audit                         Audit log (paginated)
GET    /api/v1/oauth/anthropic/start         Begin Anthropic OAuth PKCE flow
GET    /api/v1/oauth/anthropic/callback      Exchange code, store tokens
GET    /api/sse                              Server-Sent Events (task progress, OWD approvals, extension events)
POST   /api/v1/auth/register                 Register user + workspace
POST   /api/v1/auth/login                    Verify credentials
```

---

## Testing

```bash
pnpm test:unit         # unit tests, no network/DB — Vitest, <1s
pnpm test:integration  # integration tests, real Postgres — queue semantics
pnpm test:e2e          # Playwright E2E tests — API health, task API, auth UI, dashboard render
pnpm typecheck         # tsc --noEmit across all packages — must pass before committing
```

---

## Roadmap

> Updated with every push. Last updated: 2026-03-04

### ✅ Phase 1 — Foundation
- [x] pnpm workspace monorepo, Turborepo pipeline
- [x] PostgreSQL 16 + pgvector schema (20+ tables)
- [x] Drizzle ORM + migrations
- [x] Next.js 15 App Router shell — login, register, dashboard
- [x] Docker Compose stack (Postgres, Redis, Caddy, API, Web)
- [x] Typed plugin SDK interface
- [x] Agent/queue/db package scaffolds

### ✅ Phase 2 — Agent runtime
- [x] User registration — bcrypt(12), workspace auto-creation
- [x] Anthropic OAuth — PKCE flow, token exchange, auto-refresh
- [x] Planner — generates `ExecutionPlan` JSON with safety limits
- [x] Executor — multi-turn tool dispatch (read_file, write_file, shell, task_complete)
- [x] Task steps persisted with token/cost accounting
- [x] Agent loop — polls queue, executes tasks, emits SSE events
- [x] SSE emitter — per-workspace + global broadcast, heartbeats
- [x] `GET /health` — live Postgres + Redis latency

### ✅ Phase 3 — Core features
- [x] Vitest unit + integration tests
- [x] Live task API — list (paginated), create, detail with steps, cancel, stats
- [x] Live sprint API — list, create, detail with tasks, status transitions
- [x] Dashboard summary API — agent status, task counts, cost + cost ceiling
- [x] Telegram channel adapter — webhook, message→task, chat reply
- [x] Redis PKCE store — atomic GET+DEL, 10-min TTL, replay-proof
- [x] Live dashboard — server components, QuickSend widget

### ✅ Phase 4 — Channels + one-way doors
- [x] Slack channel adapter — Events API, HMAC signature verification
- [x] One-way door service — Redis-backed approval flow
- [x] OWD REST API — list/get/approve/reject
- [x] Anthropic OAuth tokens encrypted at rest (AES-256-GCM, workspace-scoped key derivation)
- [x] Playwright E2E tests
- [x] Cost write-back — `api_cost_tracking` weekly upsert, 80% ceiling alert flag

### ✅ Phase 5 — Sprint engine
- [x] GitHub API client — branch CRUD, PR creation/merge, CI check polling
- [x] Sprint planner — decomposes repo+request into ≤8 parallel tasks (topological wave execution)
- [x] Conflict detection — static (scope overlap) + dynamic (GitHub compare post-execution)
- [x] Sprint runner — wave orchestration, branch creation, task dispatch, PR creation
- [x] Discord adapter — Interactions API, Ed25519 verification, /task slash command

### ✅ Phase 6 — Memory + self-improvement
- [x] Semantic memory store — `memory_entries` + pgvector HNSW index
- [x] Workspace preference learning — confidence-weighted upsert, inference from task outcomes
- [x] Self-improvement loop — scans `work_ledger`, stores proposals in `agent_improvement_log`
- [x] Executor hook — records every outcome, infers preferences (non-blocking)

### ✅ Phase 7 — Production hardening
- [x] Rate limiting — 300/15min general, 20/15min auth, 60/15min task creation
- [x] API versioning — `/api/v1/` canonical, `/api/` backward-compat aliases
- [x] BSL 1.1 license (→ Apache 2.0 on 2030-03-03)
- [x] Setup wizard — `/setup`, 5-step browser onboarding
- [x] Full task/sprint/settings/memory/logs/debug pages

### ✅ Phase 8 — Multi-provider AI
- [x] Vercel AI SDK migration — unified API across all providers
- [x] Provider registry — `buildModel`, `resolveModel`, `withFallback` — fallback chains
- [x] 9 providers — Anthropic, OpenAI, Google, Mistral, Groq, xAI, DeepSeek, Ollama, OpenRouter
- [x] AI Providers settings page — provider cards, test connection, fallback chain config

### ✅ Phase 9-11 — Settings, connections, membership
- [x] Channels, Cron, Agent, Users settings pages
- [x] Workspace membership + invite system
- [x] Connections browser — OAuth2 popup flow, per-tool enable/disable

### ✅ Phase 12-13 — Plugin runtime (Kapsel)
- [x] Plugin install/enable/disable/uninstall API
- [x] Plugin tool bridge — sandbox via `worker_threads`, builds Vercel AI SDK ToolSet
- [x] Audit log — `audit_log` table, `GET /api/audit`
- [x] Workspace rate limit — Redis sliding-window, configurable per workspace

### ✅ Phase 14-15 — Kapsel standard + self-improvement
- [x] `@plexo/sdk` fully rewritten to Kapsel Protocol Spec v0.2.0 (Full compliance)
- [x] Manifest validation (§3.3) + `minHostLevel` enforcement (§11.4) on install
- [x] Activation-model tool discovery — extensions call `sdk.registerTool()` in sandbox
- [x] Host-side `KapselSDK` with capability enforcement at every call (§4)
- [x] Prompt improvement proposals with A/B variant assignment and auto-promotion

### ✅ Phase 16-17 — Production deployment
- [x] Production Dockerfile — multi-stage build, non-root user, health check
- [x] `docker/compose.prod.yml` — all services wired, Caddy TLS, `.env` injection
- [x] `docs/deployment.md` — self-host guide, DNS, Anthropic OAuth, backup strategy

### ✅ Phase 18-20 — Event Bus, OWD gate, deploy docs
- [x] Event Bus — in-process EventEmitter + Redis pub/sub fan-out for multi-container deployments
- [x] Namespace enforcement — extensions publish to `ext.<scope>.*` only; host to `plexo.*`; system to `sys.*`
- [x] OWD executor gate — agent pauses, writes to Redis, waits for dashboard approval before destructive ops
- [x] `std_topics` + `extensionTopic()` helper

### ✅ Phase 21-23 — Persistent workers, Event Bus fan-out, Registry
- [x] **Persistent Worker Pool** — one long-lived Worker per extension, reused across invocations (§5.4)
- [x] Crash recovery — removes from pool, emits `sys.extension.crashed`, re-spawns on next call
- [x] Per-call hard timeout — terminates the worker on breach, not just the Promise
- [x] **Event Bus v2** — Redis pub/sub fan-out with loop protection; dynamic import on startup
- [x] **Kapsel Registry** (§12) — search, detail, publish (with manifest validation + SHA-256 checksum), deprecate
- [x] `kapsel_registry` table + SQL migration

### ✅ Phase 24-25 — SDK bridge, OWD→SSE, observability
- [x] **SDK host bridge** — all capability stubs real: storage→Redis, memory→pgvector, connections→DB, tasks→queue, events→event bus
- [x] Message-based protocol — workers post `sdk_call`; host handles and replies `bridge_reply`; no host imports in worker
- [x] **OWD → SSE push** — `requestApproval()` emits `plexo.owd.pending`; API subscribes and forwards to workspace SSE clients; approval banner appears in real time
- [x] **Worker stats in `/health`** — `kapsel.workers[]` shows active persistent workers with tool counts
- [x] CORS hardened — always allows `localhost:3000/3001` in dev regardless of `PUBLIC_URL`

### 🔲 Backlog
- [ ] External Kapsel Marketplace — separate hosted service; Plexo instances pull from it
- [ ] `task_source: 'extension'` fully propagated — pending enum migration in all environments
- [ ] Webchat widget refinements
- [ ] MCP server protocol adapter (extensions that expose MCP servers)

---

## Health

The `/health` endpoint reports live service status, Kapsel compliance, and active persistent worker count.

```json
{
  "status": "ok",
  "services": {
    "postgres": { "ok": true, "latencyMs": 1 },
    "redis":    { "ok": true, "latencyMs": 1 },
    "anthropic": { "ok": false, "latencyMs": 0 }
  },
  "version": "0.1.0",
  "uptime": 864,
  "kapsel": {
    "complianceLevel": "full",
    "specVersion": "0.2.0",
    "host": "plexo",
    "workers": []
  }
}
```

Anthropic is marked non-critical — the agent degrades to queue-only mode if the AI provider is unreachable.

---

## Development

```bash
pnpm install
docker compose -f docker/compose.dev.yml up -d   # Postgres + Redis
cp .env.example .env.local                        # fill in DATABASE_URL, REDIS_URL, SESSION_SECRET
pnpm dev                                          # all apps in watch mode
```

```bash
pnpm test:unit          # unit tests, no services needed
pnpm test:integration   # needs Postgres running
pnpm typecheck          # must pass before committing
```

---

## Managed hosting

[getplexo.com](https://getplexo.com) — fully managed, zero-config, auto-updated. Same codebase as self-hosted.

---

## License

BSL 1.1 — converts to Apache 2.0 on 2030-03-03. See [LICENSE](LICENSE).
