<div align="center">

# Plexo

**An AI agent that works for you, 24/7, on your own server.**

Plexo runs a persistent agent that handles real work autonomously — and interrupts only when a real decision is needed. It communicates through channels you already use: Telegram, Slack, Discord. It learns from every task it completes.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs)](https://nextjs.org)
[![Docker](https://img.shields.io/badge/self--hosted-Docker-2496ED?logo=docker&logoColor=white)](docker/compose.yml)
[![Build](https://img.shields.io/badge/typecheck-passing-brightgreen)](https://github.com/dustin-olenslager/plexo)
[![Tests](https://img.shields.io/badge/unit%2FE2E-48%20passing-brightgreen)](https://github.com/dustin-olenslager/plexo)
[![Phase](https://img.shields.io/badge/phase-7%20in%20progress-6366f1)](https://github.com/dustin-olenslager/plexo#roadmap)
[![License](https://img.shields.io/badge/license-BSL%201.1-orange)](LICENSE)

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

**Claude.ai OAuth (Pro/Max subscription)** — connect your Claude.ai account instead of buying API credits. Uses the same PKCE OAuth flow as Claude's own apps. No API key needed. Tokens are stored encrypted, auto-refreshed before expiry. This is the same mechanism used by [OpenClaw](https://openclaw.ai) and similar Claude subscription wrappers.

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
| **AI** | Anthropic Claude (claude-3-5-haiku / claude-3-5-sonnet) | Best instruction-following, tool use, long context |
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
│   ├── agent/        Planner + Executor, Anthropic OAuth, tool dispatch
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
  └─▶ Planner (Claude)           generates ExecutionPlan JSON
        └─▶ Executor             dispatches tools step by step
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
GET    /api/channels/discord/info             Discord adapter status + supported commands
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

Plugins are loaded at runtime from the `plugins/` directory. No restart needed after adding a plugin. Breaking changes to the SDK require a major version bump with a migration guide.

---

## Testing

```bash
pnpm test:unit         # 24 tests, no network/DB — Vitest, <1s
pnpm test:integration  # 6 tests, real Postgres — queue semantics
pnpm test:e2e          # 14 Playwright E2E tests — API health, task API, auth UI, dashboard render
pnpm typecheck         # tsc --noEmit across all packages
```

Unit test coverage: errors, agent constants, Anthropic OAuth (PKCE URL, headers, token refresh).
Integration coverage: queue push/list/complete/block/cancel/priority ordering.
E2E coverage: API health (Postgres+Redis), task API edge cases, OAuth metadata, one-way door API, login UI, dashboard render with live data.

---

## Roadmap

> Updated with every push. Last updated: 2026-03-03 @ phase-5-complete

### ✅ Phase 1 — Foundation (`dffedb9`)
- [x] pnpm workspace monorepo, Turborepo pipeline
- [x] PostgreSQL 16 + pgvector schema (20 tables)
- [x] Drizzle ORM + migrations
- [x] Next.js 15 App Router shell — login, register, dashboard
- [x] Docker Compose stack (Postgres, Redis, Caddy, API, Web)
- [x] Typed plugin SDK interface
- [x] Agent/queue/db package scaffolds

### ✅ Phase 2 — Agent runtime (`060f8b3`)
- [x] User registration — bcrypt(12), workspace auto-creation
- [x] Password verification — constant-time comparison
- [x] Anthropic OAuth — PKCE flow, token exchange, auto-refresh
- [x] Planner — Claude generates `ExecutionPlan` JSON with safety limits
- [x] Executor — multi-turn tool dispatch (read_file, write_file, shell, task_complete)
- [x] Task steps persisted to `task_steps` table with token/cost accounting
- [x] Agent loop — polls queue, executes tasks, emits SSE events
- [x] SSE emitter — per-workspace and global broadcast, heartbeats
- [x] `GET /health` — live Postgres + Redis latency

### ✅ Phase 3 — Core features (`427d83d`)
- [x] Vitest unit tests (24 tests) — errors, constants, Anthropic OAuth
- [x] Vitest integration tests (6 tests) — real Postgres, queue semantics
- [x] Live task API — list (paginated), create, detail with steps, cancel, stats
- [x] Live sprint API — list, create, detail with tasks, status transitions
- [x] Dashboard summary API — agent status, task counts, cost vs ceiling, steps/tokens
- [x] Telegram channel adapter — webhook, secret validation, message→task, chat reply
- [x] Redis PKCE store — atomic GET+DEL Lua script, 10-min TTL, replay-proof
- [x] Live dashboard — server components fetch real data, dynamic cost colors, task feed
- [x] QuickSend widget — client-side task submission from dashboard
- [x] Lazy DB client — no `DATABASE_URL` throw at import, enables unit test isolation

### ✅ Phase 4 — Channels + one-way doors
- [x] Slack channel adapter — Events API, HMAC signature verification (replay-safe), message→task, thread reply
- [x] One-way door service — Redis-backed pending decisions, `requestApproval / waitForDecision / resolveDecision`
- [x] OWD REST API — list/get/approve/reject, SSE events on resolution
- [x] Anthropic OAuth tokens persisted encrypted (AES-256-GCM) to `installed_connections` table
- [x] Per-workspace key derivation from root secret — credentials isolated by workspace
- [x] Auto-refresh on token retrieve when expiring within 60s
- [x] Playwright E2E — 14 tests, chromium, API + browser, `E2E_SKIP_BROWSER=true` for CI
- [x] Cost write-back from executor to `api_cost_tracking` — weekly upsert, `alerted_80` flag
- [x] `slack` + `discord` added to `task_source` DB enum (migration applied)
- [x] Dashboard UUID guard on `/summary` and `/activity` routes

### ✅ Phase 5 — Sprint engine (in progress)
- [x] GitHub API client — branch CRUD, PR creation/merge, CI check polling, compare for conflict detection
- [x] Sprint planner — Claude decomposes repo+request into ≤8 parallel SprintTasks with dependency ordering (topological wave execution)
- [x] Conflict detection — static (scope overlap pre-execution) + dynamic (GitHub compare post-execution)
- [x] Sprint runner — orchestrates wave execution, branch creation, task queue dispatch, PR creation, sprint status write-back
- [x] Sprint API — `POST /:id/run` (async), `GET /:id/tasks` (full task tree), `GET /:id/conflicts`
- [x] Sprint detail page — server component with progress bar, task tree, status badges, scope pills, PR links
- [x] Discord adapter — Interactions API, Ed25519 signature verification, /task slash command with deferred response, guild→workspace mapping, `scripts/discord-register-commands.mjs`
- [x] Sprint list page — server component with status dots, progress bars, task/failure/conflict counts
- [x] Sprint creation form — client component, repo+request, auto-run toggle
- [x] Sprints sidebar nav item
- [x] 19 E2E tests passing (API health, all channel adapters, discord 401, sprints, login UI, dashboard)

### ✅ Phase 6 — Memory + self-improvement (in progress)
- [x] Semantic memory store — `memory_entries` + pgvector HNSW index, optional OpenAI embedding (graceful degradation to ILIKE text search)
- [x] Workspace preference learning — confidence-weighted upsert per key, language/framework/tool inference from task outcomes
- [x] Self-improvement loop — Claude Haiku scans `work_ledger`, stores proposals in `agent_improvement_log`, auto-applies tool preferences
- [x] Executor hook — records every task outcome + infers preferences post-completion (non-blocking)
- [x] Memory API — `/api/memory/search`, `/api/memory/preferences`, `/api/memory/improvements`, `/api/memory/improvements/run`
- [x] Insights page — workspace preferences grid + improvement log with pattern type badges
- [x] DB migration 0002 — `workspace_preferences` + `agent_improvement_log` tables
- [ ] Plugin marketplace UI (install/enable/configure)
- [ ] Recursive self-improvement: agent proposes and tests its own prompt changes
- [ ] Recursive self-improvement — agent identifies patterns in its own failures, proposes changes
- [ ] Plugin marketplace — install from registry, sandboxed, signed

### 🗓 Phase 7 — Production hardening
- [ ] Setup wizard — browser-based, handles all config, no terminal after clone
- [ ] Sandbox tools in Docker containers (not in API process)
- [ ] k6 load tests against VPS limits
- [ ] Multi-workspace isolation, RBAC
- [ ] Managed hosting (getplexo.com)

---

## Health

The `/health` endpoint reports live service status. Use it for uptime monitoring.

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

Anthropic is marked non-critical — the agent degrades to queue-only mode if the Anthropic API is unreachable.

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

MIT — see [LICENSE](LICENSE).
