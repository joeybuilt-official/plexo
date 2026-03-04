# Changelog

All notable changes to Plexo are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)

## [Unreleased]

### Added
- BSL 1.1 license (converts to Apache 2.0 on 2030-03-03)
- Commercial context + ZeroClaw parity gate in AGENTS.md
- `.agents-local.md` gitignored for private operational notes

---

## [0.7.0-dev] — 2026-03-04 (Phase 7A continued + UX polish)

### Added
- **Approvals page** (`/approvals`) — review queue for one-way-door operations: approve/reject with risk level banners, task link, 5s polling auto-refresh
- **Sidebar approval badge** — red count badge on Approvals nav item, polls every 10s; visibility cue when agent is waiting for a decision
- **Task cancel button** — `DELETE /api/tasks/:id` wired to task detail page; visible for `pending` and `running` tasks only; triggers `router.refresh()` post-cancel
- **First-run redirect** — dashboard home checks `GET /api/workspaces`; if no workspaces exist, redirects to `/setup`. Timeout-safe (2s abort) — API unreachable yields graceful fallback

### Changed
- **Marketplace install errors** — API errors now surfaced as red inline text on the card instead of silently failing

---

## [0.7.0-dev] — 2026-03-04 (Phase 7A — Parity & Stability)

### Added
- **Telegram setup wizard** — 3-step guided onboarding in `/settings/channels`: BotFather instructions → live token verify via Telegram API → webhook secret. Auto-advances on successful token verify
- **Memory/Insights browser** — converted to interactive client component: semantic search (`GET /api/memory/search`), run improvement cycle button, per-entry Apply buttons
- **AI Providers fallback chain reordering** — ▲▼ buttons reorder configured providers; fallback order persisted to `workspace.settings.aiProviders.fallbackOrder`

### Changed
- **Settings page** — now a client component; loads real workspace data on mount; saves to `PATCH /api/workspaces/:id`; API Keys section replaced with info panel + env var reference pointing to AI Providers
- **`PATCH /api/workspaces/:id`** — deep-merges settings object (read-modify-write) to prevent cross-section overwrites
- **Settings > Agent** — `handleSave` wired to real API; loads persisted `defaultModel`, `tokenBudgetPerTask`, `maxRetries` from workspace settings on mount

---

## [0.7.0-dev] — 2026-03-04 (Phase 7B/C/D — Personality, Control Room, Webchat, NLP Cron)

### Added
- **Agent personality system prompt** — executor fetches workspace `agentName` and `agentPersona` from DB; injects them into the system prompt dynamically
- **Sprint control room** (`/sprints/[id]`) — live client page with SSE, worker grid, per-tab views (workers/tasks/features delivered), velocity metric cards (elapsed, cost, throughput), wall-clock timer, live active-worker banner
- **Sprint velocity metrics** on `/sprints` list — total projects, completed count, success rate, avg tasks/sprint, total spend
- **Webchat widget** — `POST /api/chat/message` queues a task, `GET /api/chat/reply/:taskId` long-polls for agent reply, `GET /api/chat/widget.js` serves embeddable vanilla JS bubble widget
- **Webchat embed snippet** on `/settings/channels` page — shows copyable `<script>` tag with workspace ID
- **NLP-to-cron parser** — `POST /api/cron/parse-nl` converts plain English schedules to cron expressions (deterministic, no AI call). UI in `/cron` add form fills schedule field from natural language input with Enter-to-parse and green confirmation

### Changed
- Sprint card shows wall clock time alongside cost
- Sprint list page is now a clean server component rewrite (removed duplicate declarations from earlier partial edit)

---

## [0.7.0-dev] — 2026-03-04 (Phase 10 — Live Dashboard + Debug + Connections Tools)

### Added
- **LiveDashboard** client component — SSE + polling (15s summary, 10s activity), manual refresh, last-updated timestamp. Dashboard page now uses `LiveDashboard` instead of static server components
- **Runtime Snapshot** panel in debug page — `GET /api/debug/snapshot` returns queue depth, sprint task counts, work ledger 7d stats, SSE client count, process info
- **RPC Console** in debug page — `POST /api/debug/rpc` with allowlisted methods: `ping`, `queue.stats`, `memory.list`, `memory.run_improvement`, `agent.status`
- **Connections Tools tab** — per-tool enable/disable toggles backed by `enabled_tools jsonb` column in `installed_connections` (migration 0004)
- `PUT /api/connections/installed/:id/tools` — save enabled tools list per connection

### Changed
- Dashboard page converted from server component to `LiveDashboard` client component
- Debug page adds Runtime Snapshot + RPC Console panels
- Connections page: Overview/Tools/Config tabbed detail panel

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
