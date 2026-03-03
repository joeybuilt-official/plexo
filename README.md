<div align="center">

# Plexo

**An AI agent that works for you, 24/7, on your own server.**

Plexo runs a persistent agent that handles real work autonomously — and interrupts only when a real decision is needed. It communicates through channels you already use: Telegram, Slack, Discord. It learns from every task it completes.

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-orange.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/self--hosted-Docker-2496ED?logo=docker&logoColor=white)](docker/compose.yml)
[![Build](https://img.shields.io/badge/typecheck-passing-brightgreen)](https://github.com/dustin-olenslager/plexo)
[![Phase](https://img.shields.io/badge/phase-8%20complete-brightgreen)](https://github.com/dustin-olenslager/plexo#roadmap)

[**Managed hosting →**](https://getplexo.com) · [Docs](docs/) · [Plugin SDK](docs/plugin-sdk.md) · [Architecture](docs/architecture.md)

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
| **Personal automation** | Recurring scheduled tasks, monitoring with notifications, custom workflows via plugins |

---

## Self-host in under 20 minutes

```bash
git clone https://github.com/dustin-olenslager/plexo
cd plexo
cp .env.example .env   # fill in 5 values
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
SECRET=any-random-string          # for signing sessions
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
| **Cache / queue** | Redis (Valkey-compatible) | PKCE state, task queue, session cache |
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
│   ├── api/          Express 5 — agent loop, task/sprint APIs, channel adapters, SSE
│   └── web/          Next.js 15 — dashboard, auth, settings
├── packages/
│   ├── agent/        Planner + Executor, provider registry, tool dispatch
│   ├── db/           Drizzle schema, migrations, lazy client
│   ├── queue/        Task queue (push/list/complete/block/cancel)
│   └── sdk/          Public plugin API (stable interface — semver enforced)
├── plugins/
│   └── core/         Built-in tools (read_file, write_file, shell, task_complete)
├── docker/           Compose files, Caddy config
├── docs/             Architecture, plugin SDK guide
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
              ├─▶ shell          run commands (sandboxed in Phase 4)
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
| No force-push / delete without confirmation | Always |

One-way door operations (schema migrations, public API changes, destructive shell commands) require explicit approval via channel or dashboard before execution.

---

## Channel adapters

| Channel | Status | Notes |
|---------|--------|-------|
| **Telegram** | ✅ Phase 3 | Webhook, secret validation, message→task, chat reply |
| **Slack** | ✅ Phase 4 | Events API, HMAC signature verification, message→task, thread reply |
| **Discord** | ✅ Phase 5 | Interactions API, Ed25519 signature verification, /task slash command |
| **Dashboard** | ✅ Phase 3 | QuickSend widget, task feed, live cards |
| **API** | ✅ Phase 3 | REST — `POST /api/tasks` |

---

## API surface

All routes require a valid `workspaceId` UUID.

```
GET    /health                               Postgres + Redis latency, version, uptime
GET    /api/tasks                            List tasks (paginated, filter by status/type)
POST   /api/tasks                            Create task
GET    /api/tasks/:id                        Task detail + execution steps
DELETE /api/tasks/:id                        Cancel task
GET    /api/tasks/stats/summary              Counts by status + cost totals
GET    /api/sprints                          List sprints
POST   /api/sprints                          Create sprint
GET    /api/sprints/:id                      Sprint detail + linked tasks
PATCH  /api/sprints/:id                      Update status
GET    /api/dashboard/summary                All dashboard card data (one request)
GET    /api/dashboard/activity               Recent task feed
POST   /api/channels/discord/interactions    Discord Interactions (slash commands, ping verification)
GET    /api/channels/discord/info            Discord adapter status + supported commands
GET    /api/channels/telegram/info           Telegram adapter status
POST   /api/channels/slack/events            Slack Events API (URL challenge + message events)
GET    /api/channels/slack/info              Slack adapter status
GET    /api/approvals                        List pending one-way door decisions (workspaceId)
GET    /api/approvals/:id                    Get decision by ID
POST   /api/approvals/:id/approve            Approve a destructive operation
POST   /api/approvals/:id/reject             Reject a destructive operation
GET    /api/oauth/anthropic/start            Begin Anthropic OAuth PKCE flow
GET    /api/oauth/anthropic/callback         Exchange code, store tokens (encrypted)
GET    /api/oauth/anthropic/info             OAuth app metadata
GET    /api/sse                              Server-Sent Events (real-time task progress + OWD events)
POST   /api/auth/register                    Register user + workspace
POST   /api/auth/login                       Verify credentials
GET    /api/memory/search                    Semantic memory search (pgvector + ILIKE fallback)
GET    /api/memory/preferences               Workspace learned preferences
GET    /api/memory/improvements              Agent self-improvement proposals
POST   /api/memory/improvements/run          Trigger self-improvement cycle
GET    /api/connections                      List installed service connections
```

---

## Plugin system

Plugins extend the agent's tool set without touching core. They are isolated Node.js modules that import only from `@plexo/sdk` — never from `packages/db` or `packages/agent`.

```ts
import { defineTool } from '@plexo/sdk'

export default defineTool({
  name: 'stripe_report',
  description: 'Generate a Stripe revenue report for a date range',
  schema: z.object({ from: z.string(), to: z.string() }),
  execute: async ({ from, to }) => {
    // ...
    return { summary, csv }
  },
})
```

Plugins are loaded at runtime from the `plugins/` directory. No restart needed after adding a plugin.

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

> Updated with every push. Last updated: 2026-03-03

### ✅ Phase 1 — Foundation
- [x] pnpm workspace monorepo, Turborepo pipeline
- [x] PostgreSQL 16 + pgvector schema (20 tables)
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
- [x] OWD REST API — list/get/approve/reject, SSE events on resolution
- [x] Anthropic OAuth tokens encrypted at rest (AES-256-GCM, workspace-scoped key derivation)
- [x] Playwright E2E tests
- [x] Cost write-back — `api_cost_tracking` weekly upsert, 80% ceiling alert flag

### ✅ Phase 5 — Sprint engine
- [x] GitHub API client — branch CRUD, PR creation/merge, CI check polling
- [x] Sprint planner — decomposes repo+request into ≤8 parallel tasks (topological wave execution)
- [x] Conflict detection — static (scope overlap) + dynamic (GitHub compare post-execution)
- [x] Sprint runner — wave orchestration, branch creation, task dispatch, PR creation
- [x] Sprint API — `POST /:id/run`, `GET /:id/tasks`, `GET /:id/conflicts`
- [x] Sprint list + detail pages
- [x] Discord adapter — Interactions API, Ed25519 verification, /task slash command

### ✅ Phase 6 — Memory + self-improvement
- [x] Semantic memory store — `memory_entries` + pgvector HNSW index
- [x] Workspace preference learning — confidence-weighted upsert, inference from task outcomes
- [x] Self-improvement loop — scans `work_ledger`, stores proposals in `agent_improvement_log`
- [x] Executor hook — records every outcome, infers preferences (non-blocking)
- [x] Memory API — `/api/memory/*`
- [x] Insights page — preferences grid + improvement log

### ✅ Phase 7 — Production hardening
- [x] Rate limiting — 300/15min general, 20/15min auth, 60/15min task creation
- [x] API versioning — `/api/v1/` canonical, `/api/` backward-compat aliases
- [x] BSL 1.1 license (→ Apache 2.0 on 2030-03-03)
- [x] Full CHANGELOG
- [x] Setup wizard — `/setup`, 5-step browser onboarding
- [x] Tasks page — filterable list, auto-refresh
- [x] Task detail page — meta grid, execution trace with tool calls
- [x] Conversations page — date-grouped channel activity feed
- [x] Logs page — tabular work_ledger view with quality/cost columns
- [x] Settings page — workspace, agent model/budget, API key management
- [x] k6 smoke test

### ✅ Phase 8 — Multi-provider AI + navigation
- [x] **Vercel AI SDK migration** — unified `generateObject` / `generateText` / tool API across all providers
- [x] **Provider registry** — `buildModel`, `resolveModel`, `withFallback` — fallback chains with retryable error detection
- [x] **9 providers supported** — Anthropic, OpenAI, Google, Mistral, Groq, xAI, DeepSeek, Ollama (via OpenAI-compat), OpenRouter
- [x] **Grouped sidebar** — collapsible sections (Chat · Control · Agent · Settings · System), state persisted to localStorage
- [x] **AI Providers settings page** — two-panel UI, provider cards, API key config, test connection, primary selection, fallback chain, model routing per task type
- [x] **`POST /api/settings/ai-providers/test`** — Express handler via `testProvider()` in registry, proxied through Next.js route
- [x] **Connections browser** — two-panel UI backed by real `/api/connections/registry` + `/api/connections/installed`, OAuth2 popup flow, API key config, disconnect
- [x] **SSE-driven dashboard refresh** — `DashboardRefresher` client component calls `router.refresh()` on task events, falls back to 15s polling
- [x] **Workspace resolver** — `getWorkspaceId()` server util resolves from NextAuth session via `/api/workspaces?ownerId=...`, React `cache()` deduped
- [x] **Insights page real data** — uses `getWorkspaceId()`, renders preferences grid + improvement log from live API
- [x] **Debug page** — health endpoint with service latencies, SSE stream monitor + live event feed, route diagnostic table, client-side env panel
- [x] **New routes** — `/settings/ai-providers`, `/settings/connections`, `/settings/channels`, `/settings/agent`, `/settings/users`, `/debug`, `/projects`, `/cron`

### ✅ Phase 9 — Settings completion + API surface
- [x] **Channels settings** — two-panel UI: type picker (Telegram/Slack/Discord/WhatsApp/Signal/Matrix), per-adapter config fields, enable/disable toggle, delete — backed by `GET/POST/PATCH/DELETE /api/channels`
- [x] **Cron jobs page** — table with enable/disable, manual trigger, delete; add form with schedule preset chips — backed by `GET/POST/PATCH/DELETE /api/cron` + `POST /api/cron/:id/trigger`
- [x] **Agent settings** — live agent status banner (model, task, session count), model override, system prompt addition, execution limits (max steps/tokens), weekly cost ceiling, quality auto-approve threshold, safe mode toggle — saves to `workspace.settings` JSONB via `PATCH /api/workspaces/:id`
- [x] **Users settings** — two-panel with avatar initials, role badge, name/role editing backed by `GET/PATCH /api/users`
- [x] **Projects route** — sidebar "Projects" links directly to `/sprints` (canonical); placeholder redirect removed
- [x] **New API routes** — `GET/POST/PATCH/DELETE /api/channels`, `GET/POST/PATCH/DELETE /api/cron`, `POST /api/cron/:id/trigger`, `GET/PATCH /api/users`, `PATCH /api/workspaces/:id`
- [x] All placeholder pages eliminated — every sidebar route now renders real content

### 🔲 Backlog
- [ ] Sandbox tools in isolated Docker containers
- [ ] Multi-workspace RBAC + workspace membership table
- [ ] Plugin marketplace — install from registry, sandboxed, signed
- [ ] Recursive self-improvement — agent proposes + tests its own prompt changes


---

## Health

The `/health` endpoint reports live service status.

```json
{
  "status": "ok",
  "services": {
    "postgres": { "ok": true, "latencyMs": 2 },
    "redis":    { "ok": true, "latencyMs": 2 },
    "anthropic": { "ok": false, "latencyMs": 0 }
  },
  "version": "0.1.0",
  "uptime": 42
}
```

Anthropic is marked non-critical — the agent degrades to queue-only mode if the AI provider is unreachable.

---

## Development

```bash
pnpm install
docker compose -f docker/compose.dev.yml up -d   # Postgres + Redis
cp .env.example .env.local                       # fill in DATABASE_URL, REDIS_URL
pnpm db:migrate
pnpm dev                                         # all apps in watch mode
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
