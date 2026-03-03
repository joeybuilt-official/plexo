# Changelog

All notable changes to Plexo are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [Unreleased]

### Added
- BSL 1.1 license (converts to Apache 2.0 on 2030-03-03)
- Commercial context + ZeroClaw parity gate in AGENTS.md
- `.agents-local.md` gitignored for private operational notes

---

## [0.6.0] — 2026-03-03 (Phase 6 — Memory + Self-Improvement)

### Added
- **Semantic memory store** (`packages/agent/src/memory/store.ts`)
  - `storeMemory` / `searchMemory` / `recordTaskMemory`
  - pgvector HNSW cosine similarity search (text-embedding-3-small via OpenAI when key present)
  - ILIKE text fallback when no embedding API key configured
- **Workspace preference learning** (`packages/agent/src/memory/preferences.ts`)
  - `learnPreference` — confidence-accumulating upsert (capped at 0.95)
  - `inferFromTaskOutcome` — infers language, test framework, tool success rates from file/tool trace
- **Self-improvement loop** (`packages/agent/src/memory/self-improvement.ts`)
  - Claude Haiku scans `work_ledger`, proposes up to 5 patterns per cycle
  - Stores proposals in `agent_improvement_log`; auto-applies `tool_preference` type
- **Recursive prompt improvement** (`packages/agent/src/memory/prompt-improvement.ts`)
  - `proposePromptImprovements` — LLM proposes targeted system prompt patches
  - `applyPromptPatch` — operator applies approved patches to `workspace_preferences['prompt_overrides']`
  - No code deploy required; executor reads overrides at task start
- **Executor hook** — records every task outcome + preference inference post-completion (non-blocking)
- **Memory API** (`apps/api/src/routes/memory.ts`)
  - `GET /api/memory/search` — semantic + text fallback search
  - `GET /api/memory/preferences` — workspace preference map
  - `GET /api/memory/improvements` — improvement log
  - `POST /api/memory/improvements/run` — trigger self-improvement cycle (202 async)
  - `POST /api/memory/improvements/prompt` — trigger prompt improvement analysis (202 async)
  - `POST /api/memory/improvements/:id/apply` — operator applies a specific prompt patch
- **Insights page** (`apps/web/src/app/(dashboard)/insights/page.tsx`)
  - Preferences grid + improvement log with pattern type badges
  - Brain icon in sidebar nav
- **Marketplace** (`apps/web/src/app/(dashboard)/marketplace/`)
  - Server page + interactive `MarketplaceClient`
  - Searchable, category-filterable integration grid
  - Inline credential setup fields; optimistic install/remove state
  - 10 integrations seeded: GitHub, Slack, Discord, Telegram, OpenAI, Linear, Jira, Notion, PagerDuty, Datadog
- **Connections API** (`apps/api/src/routes/connections.ts`)
  - `GET /api/connections/registry` + `GET /api/connections/registry/:id`
  - `GET /api/connections/installed`, `POST /api/connections/install`
  - `PATCH /api/connections/installed/:id`, `DELETE /api/connections/installed/:id`
- **DB migrations**
  - `0002_memory_preferences.sql` — `workspace_preferences` + `agent_improvement_log` tables
  - `0003_connections_seed.sql` — 10 registry integrations
- **Drizzle schema** — `workspacePreferences` + `agentImprovementLog` table definitions
- 5 new Memory API E2E tests (24/24 total passing)

### Security
- `AGENTS.md` scrubbed of credentials and internal VPS migration details
- `.agents-local.md` added to `.gitignore` for private operational notes

---

## [0.5.0] — 2026-03-03 (Phase 5 — Sprint Engine)

### Added
- **GitHub client** (`packages/agent/src/github/client.ts`) — fetch-based, no external deps
  - Branch CRUD, PR create/merge/update, CI status polling, file comparison
- **Sprint planner** (`packages/agent/src/sprint/planner.ts`)
  - Claude decomposes repo + request into ≤8 parallelizable tasks
  - Topological sort into execution waves, branch naming, persists to `sprint_tasks`
- **Conflict detection** (`packages/agent/src/sprint/conflicts.ts`)
  - Static (scope overlap pre-execution) + dynamic (GitHub compare post-execution)
- **Sprint runner** (`packages/agent/src/sprint/runner.ts`)
  - End-to-end: plan → branch → enqueue → poll → draft PR → conflict detect → status
- **Sprint API** (`apps/api/src/routes/sprint-runner.ts`)
  - `POST /api/sprints/:id/run` (202 async), `GET /api/sprints/:id/tasks`, `GET /api/sprints/:id/conflicts`
- **Discord adapter** (`apps/api/src/routes/discord.ts`)
  - Ed25519 signature verification, `/task` slash command with deferred response
  - Guild→workspace mapping, follow-up via webhook, `GET /api/channels/discord/info`
- **Discord command registration** script (`scripts/discord-register-commands.mjs`)
- **Sprint list page** (`apps/web/src/app/(dashboard)/sprints/page.tsx`)
- **Sprint creation form** (`apps/web/src/app/(dashboard)/sprints/new/page.tsx`)
- **Sprint detail page** (`apps/web/src/app/(dashboard)/sprints/[id]/page.tsx`)
- Sprints + Insights sidebar nav items
- 10 new E2E tests (24 total)

---

## [0.4.0] — 2026-03-02 (Phase 4 — Channel Adapters + OAuth)

### Added
- Telegram adapter (webhook ingestion, message routing)
- Slack adapter (slash commands, event subscriptions)
- Anthropic OAuth PKCE flow (token exchange, auto-refresh)
- One-way door approval flow (confirm before destructive ops)
- Live dashboard components (task list, cost summary, agent status)
- `POST /api/memory/improvements/run` placeholder

---

## [0.3.0] — 2026-03-01 (Phase 3 — Task Execution Engine)

### Added
- Agent executor with full Claude tool loop
- Tool implementations: shell, file ops, web fetch, code search
- Work ledger (token tracking, cost, quality score, calibration)
- Vitest unit test suite (24 tests)
- Playwright E2E suite (critical paths)

---

## [0.2.0] — 2026-02-28 (Phase 2 — Core Infrastructure)

### Added
- Task queue (packages/queue) with Redis-backed BullMQ
- Worker process consuming queue
- RLS-style workspace scoping on all queries
- API cost ceiling + weekly accumulation + 80% alert
- DB migrations via Drizzle

---

## [0.1.0] — 2026-02-27 (Phase 1 — Scaffold)

### Added
- Monorepo scaffold: pnpm workspaces, Turborepo, TypeScript strict
- Database schema: 21+ tables via Drizzle ORM
- Auth.js v5: credentials + GitHub OAuth
- Express 5 API server, Next.js 15 dashboard
- Docker Compose: Postgres 16 + pgvector, Valkey, Caddy
- AGENTS.md, .env.example, docs stubs
