# AGENTS.md — Plexo

## What This Is
Plexo is an open-source AI agentic platform. TypeScript monorepo, pnpm workspaces.
Read docs/architecture.md before making architectural decisions.
Read docs/plugin-sdk.md before touching packages/sdk — it is a public API.

## Stack
Next.js 15 (App Router) · shadcn/ui · Tailwind · Drizzle ORM
PostgreSQL + pgvector · Redis · Auth.js v5 · Caddy · Docker

## Commands
```bash
pnpm dev                # start all apps in dev mode
pnpm build              # full production build
pnpm test               # unit tests (Vitest)
pnpm test:integration   # integration tests
pnpm test:e2e           # Playwright E2E (requires running stack)
pnpm typecheck          # tsc --noEmit across all packages
pnpm db:migrate         # run pending migrations
pnpm db:rollback        # roll back one migration
```

## Conventions
- TypeScript strict mode. No `any` without an inline comment explaining why.
- Drizzle for all DB access. No raw SQL except pgvector operations.
- Server Actions for form mutations in Next.js. No separate API routes for forms.
- shadcn/ui for all new UI components.
- Tailwind only. No CSS modules, no styled-components.
- pnpm workspaces. Never use npm or yarn.
- `pnpm typecheck` must pass before committing.
- No TODOs merged to main.

## Package Dependency Rules
```
packages/db        → no internal dependencies
packages/sdk       → no internal dependencies (public API)
packages/queue     → packages/db only
packages/agent     → packages/db, packages/queue (never packages/sdk)
packages/ui        → no internal dependencies
apps/api           → packages/agent, packages/db, packages/queue, packages/sdk
apps/web           → packages/ui only (no direct DB or agent access)
plugins/core/*     → packages/sdk only (never packages/db or packages/agent)
```

## Critical Rules
- packages/sdk is a public API. Breaking changes require major version bump + migration guide.
- Plugins cannot import from packages/db or packages/agent. SDK only.
- SAFETY_LIMITS in packages/agent/src/constants.ts are constants. Never make them configurable.
- Secrets never in source code, logs, or error messages.
- Never create or modify `.env` or `docker/compose.override.yml` — these are operator files.
- Never commit credentials, API keys, tokens, or workspace-specific config to the repo.
- Three-click rule: every common action ≤3 clicks from home. Playwright enforces this.
- Every PR: what changed, why, how to verify, migration notes if any.

## Rollback
- Database: `pnpm db:rollback`
- Redis: safe to flush (all data is ephemeral cache/state)
- Container: `docker compose down && docker compose up -d` (image tags for rollback)

## Known Issues
*None yet.*

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-03 | Phase 1: Foundation scaffold | Initial monorepo setup, DB schema, auth, typed interfaces, Docker stack |
| 2026-03-03 | Drizzle over Prisma | No binary dependency, no generation step, SQL-native, smaller bundle |
| 2026-03-03 | Valkey over Redis | Open-source fork, API-compatible, production-stable, no license risk |
| 2026-03-03 | ULID over UUID | Lexicographically sortable, URL-safe, no coordination needed |
| 2026-03-03 | Express 5 over Fastify | Mature ecosystem, async middleware native, simpler mental model |
| 2026-03-03 | Pino over Winston | 10x faster, structured JSON native, built-in redaction |
| 2026-03-03 | Turborepo over Nx | Simpler config, faster cold starts, Vercel-maintained |

## Current State — Phase 2 Complete

### What's verified live (smoke tested locally)
- DB migration applied: 20 tables + pgvector 0.8.2 on Postgres 16
- `GET /health` → Postgres + Redis latency, Anthropic non-critical
- `POST /api/auth/register` → bcrypt(12), workspace created, UUID returned
- `POST /api/auth/verify-password` → constant-time on user-not-found
- `POST /api/auth/register` (duplicate) → 409 EMAIL_TAKEN
- `GET /api/oauth/anthropic/info` → client ID, scopes
- `GET /api/oauth/anthropic/start` → PKCE S256 URL to claude.ai/oauth/authorize
- SSE `/api/sse?workspaceId=x` → connected event + heartbeat
- Agent queue loop starts on boot, polls every 2s

### What's implemented (not yet E2E tested — requires real Anthropic key)
- Planner: Claude → structured ExecutionPlan (JSON schema enforced)
- Executor: multi-turn tool loop (read_file, write_file, shell, task_complete)
- Cost ceiling enforcement (per-task + configurable env var)
- Wall clock + consecutive tool call safety limits
- Anthropic OAuth: PKCE flow, token exchange, auto-refresh on 60s pre-expiry
- AnthropicCredential union (api_key | oauth_token) — both handled transparently

### What's stubbed (next phase)
- Channel adapters: Telegram, Slack, Discord (framework exists, no real bots)
- One-way door confirmation UI (auto-approved in Phase 2)
- OAuth token persistence (in-memory PKCE store, not Redis-backed yet)
- Dashboard cards: still placeholder data
- Unit tests: TDD infrastructure not yet set up

### Phase 3 scope (next)
- Telegram + Slack channel adapters (real message routing)
- One-way door confirmation flow via channel/dashboard
- Persist Anthropic OAuth tokens to installed_connections (encrypted)
- Move PKCE store to Redis with TTL
- Vitest unit tests: planner, executor, queue, health
- Live dashboard cards with real DB queries
- API routes for tasks/sprints with pagination
- Cost tracking to api_cost_tracking table


### Dev Environment

#### Ports
- Web (Next.js): 3000 (localhost only)
- API (Express): 3001 (localhost only)
- Postgres: 5432 (localhost only in dev; Docker-internal in prod)
- Redis: 6379 (localhost only in dev; Docker-internal in prod)
- If port conflicts arise locally, change via `.env.local` + `playwright.config.ts` E2E_API_URL/E2E_BASE_URL.

#### Dev login
- See `.agents-local.md` (gitignored)

#### Running locally
```
# API (terminal 1)
DATABASE_URL=postgresql://plexo:<password>@localhost:5432/plexo \
  REDIS_URL=redis://localhost:6379 PORT=3001 \
  ANTHROPIC_API_KEY=... ANTHROPIC_CLIENT_ID=... ENCRYPTION_SECRET=... \
  pnpm --filter @plexo/api exec tsx src/index.ts

# Web (terminal 2)
pnpm --filter @plexo/web dev
```

## Commercial Context

Plexo is being built as a commercially viable product ("the next OpenClaw").
This has implications for every decision:

- **License**: Use a source-available / BSL-style license to allow self-hosting but protect commercial offering. Decision needed from user before publishing v1.
- **API versioning**: All public-facing endpoints should be under `/api/v1/` before launch. Avoid breaking changes silently.
- **Multi-tenancy**: Workspace isolation is the core unit. RLS or tenant-scoped queries on every DB operation — no cross-tenant data leaks.
- **Billing hooks**: `api_cost_tracking` table exists. Wire to Stripe when billing is specced.
- **CHANGELOG**: Must be kept current. Every merged change gets a CHANGELOG entry before push.
- **Security first**: No credentials in logs, all secrets via env, non-root Docker, RLS on Supabase if migrated.
- **Demo and docs**: Public docs (docs/) and a hosted demo instance (Coolify) need to exist before marketing launch.
- **ZeroClaw parity gate**: Cannot migrate VPS or launch until feature parity with ZeroClaw is operator-confirmed.

### What ZeroClaw provides (parity checklist — to be specced in detail by user)
- [ ] TBD — user to spec out ZeroClaw feature list

---

## Decisions Log

### 2025-06 — Vercel AI SDK v6 Migration (Phase A)

- **ai@6 breaking changes**: `maxSteps` removed → use `stopWhen: stepCountIs(N)`. `usage.promptTokens/completionTokens` → `usage.inputTokens/outputTokens`. Tool definitions use `inputSchema:` not `parameters:`. `execute` receives `(input, options)`.
- **Ollama**: `ollama-ai-provider` is LanguageModelV1 only — incompatible with ai@6. Replaced with `@ai-sdk/openai-compatible` pointing at Ollama's `/v1` endpoint.
- **LanguageModel types**: `@ai-sdk/provider` is not a direct dep. Return type of `buildModel` uses `any` internally; generateText accepts all provider versions at runtime.
- **Tool execute typing**: Explicit parameter type annotations on execute callbacks cause TS overload mismatch. Let TypeScript infer from Zod `inputSchema`.

### 2025-06 — Navigation Restructure (Phase B)

- **Sidebar groups**: Chat · Control · Agent · Settings · System. Collapsible, state persisted in `localStorage` under `plexo:sidebar:collapse`.
- **New routes created**: `/settings/ai-providers`, `/settings/connections`, `/settings/channels`, `/settings/agent`, `/settings/users`, `/debug`, `/projects`, `/cron`.
- **AI Providers page** (Phase C): Two-panel layout. Primary selection, test connection, fallback chain display, collapsible model routing table. Test API endpoint wired in frontend; `POST /api/settings/ai-providers/test` handler not yet implemented.

### 2026-03 — Phase 8 completion (C–G)

- **AI provider test**: `testProvider()` lives in `packages/agent/src/providers/registry.ts` — all AI SDK deps stay in that package. `apps/api` imports `testProvider` from `@plexo/agent/providers/registry`; `apps/web` Next.js route is a thin proxy to Express. No AI SDK imports bleed into apps not owning them.
- **maxTokens → maxOutputTokens**: ai@6 renamed this field in `generateText`. Fixed in `testProvider` and any future uses.
- **Connections browser**: Backed by real `/api/connections/registry` + `/api/connections/installed`. Auth-type-aware install UI: OAuth2 opens popup via `window.open`, API key uses input fields + `POST /api/connections/install`.
- **DashboardRefresher**: SSE EventSource at `/api/sse?workspaceId=...` + `router.refresh()` on task events. Falls back to 15s polling on SSE failure. Reconnects after 5s. Mounted once in `(dashboard)/layout.tsx` — affects all dashboard pages.
- **Workspace resolver pattern**: `getWorkspaceId()` in `apps/web/src/lib/workspace.ts` — React `cache()` deduplicates within a render pass. All server components should import from here, NOT use raw env vars. Three different env var names were previously inconsistent across files (`DEV_WORKSPACE_ID`, `DEFAULT_WORKSPACE_ID`, `NEXT_PUBLIC_DEFAULT_WORKSPACE`). Server components use `DEV_WORKSPACE_ID` fallback; client components use `NEXT_PUBLIC_DEFAULT_WORKSPACE`.
- **workspaces API**: Added `?ownerId=` filter param. Owner is the `uuid workspace.owner_id` FK to `users.id`. Session `user.id` maps to this.
- **Debug page**: Uses only `NEXT_PUBLIC_*` vars (client component). Route checks run in parallel with `Promise.all`. SSE connection opened on mount for stream diagnostics.

### 2026-03 — Phase 10 (Live Dashboard + Debug + Connections Tools)

- **LiveDashboard**: Client component polling `/api/dashboard/summary` every 15s and `/api/dashboard/activity` every 10s. SSE via EventSource for real-time task/agent events. Manual refresh + last-updated timestamp. Replaces server-rendered DashboardCards + TaskFeed in page.tsx.
- **Debug page enhancements**: Added Runtime Snapshot panel (GET /api/debug/snapshot — queue depth, sprint_tasks, work_ledger 7d, process info) and RPC Console (POST /api/debug/rpc — allowlisted: ping, queue.stats, memory.list, memory.run_improvement, agent.status).
- **debug.ts route**: `sprint_tasks.status` enum values are `queued/running/complete/blocked/failed` (NOT `in_progress`). `work_ledger` uses `completed_at` not `created_at`. `tokens_in/tokens_out` are nullable so use COALESCE.
- **tsx watch + stdin**: Do NOT start `tsx watch` via `&` without `< /dev/null`. If stdin is a pipe, tsx reads Enter keys from subsequent shell commands and hot-restarts mid-request. Always use `cmd < /dev/null > logfile 2>&1 &`.
- **Connections Tools tab**: Per-tool enable/disable toggles backed by `enabled_tools jsonb` column in `installed_connections`. Migration 0004 applies ADD COLUMN IF NOT EXISTS. Applied directly via psql because Drizzle journal only tracks 0000 and 0001.
- **web .env.local**: `NEXT_PUBLIC_DEFAULT_WORKSPACE` and `DEV_WORKSPACE_ID` set to the dev workspace UUID. Required for LiveDashboard and other client components to make API calls.
- **API restart protocol**: `kill -9 <pid>` then restart with `cmd < /dev/null >> logfile 2>&1 &`. Wait 5s, verify with `curl -sm4 http://localhost:3001/health`. Do not use pnpm from within a background job (EBADF on stdin).

### 2026-03 — Phase 11 (Workspace Membership + Invites)

- **`workspace_members` table**: composite unique `(workspace_id, user_id)`, roles enum `member_role` = owner/admin/member/viewer. Migration 0007 backfills existing owners.
- **`workspace_invites` table**: 48-char random hex token, optional `invited_email`, role, 7-day `expires_at`, `used_at`/`used_by_user_id` for single-use enforcement.
- **Members router** (`apps/api/src/routes/members.ts`): mounted at `/api/workspaces/:id/members` with `mergeParams: true`. Params require explicit cast `(req.params as { id: string }).id` due to Express 5 typing.
- **Invite router** at `/api/invites/:token` (GET info, POST accept). POST accept upserts membership via `onConflictDoUpdate`.
- **Settings > Members page**: workspace-scoped list replaces global users list. Invite panel generates 7-day link, copy-to-clipboard. Role chips for viewer/member/admin. Remove button blocked for workspace owner.
- **`/invite/[token]` page**: standalone accept flow outside dashboard layout (no sidebar/nav). Shows workspace name + role, one-click join, redirects to `/` on success.
- **WorkspaceContext propagation**: All 11 pages using module-level `NEXT_PUBLIC_DEFAULT_WORKSPACE` constant converted to `useWorkspace()` hook inside component. `RouteRow` in debug page received `wsId` prop to avoid module-scope capture.
- **QuickSend**: now reads from `WorkspaceContext`; success message links to `/tasks/:id`.

### 2026-03 — Phase 7B/C/D (Personality, Control Room, Webchat, NLP Cron)

- **Agent personality**: `workspaces.settings` JSONB holds `agentName`, `agentPersona`, `agentTagline`, `agentAvatar`. Executor (`packages/agent/src/executor/index.ts`) dynamic-imports from `@plexo/db` to read these at task start. Non-fatal try/catch — falls back to 'Plexo' name and empty persona prefix.
- **Sprint control room** (`/sprints/[id]/page.tsx`): Full client component with SSE + 5s polling when sprint is active. Three tabs: workers (card grid), tasks (table), features (list). Six metric cards. Wall-clock timer runs locally when sprint is active.
- **Webchat**: `apps/api/src/routes/chat.ts` — POST `/api/chat/message` creates a `type:'online'` task with `source:'dashboard'`; uses `ulid()` for ID since `tasks.id` has no DB default. GET `/api/chat/reply/:taskId` long-polls up to 25s. GET `/api/chat/widget.js` returns a self-contained JS bundle injected via `<script>` tag with `data-workspace` attribute.
- **NLP cron**: `parseNl()` is a deterministic rule-based parser in `apps/api/src/routes/cron.ts` — no AI call, handles "every Monday at 9am", "daily at midnight", "every 5 minutes", etc. Registered before parameterized routes so `/parse-nl` is not mistaken for `/:id`.
- **Route ordering**: In Express, `cronRouter.post('/parse-nl', ...)` MUST be registered before `cronRouter.patch('/:id', ...)` etc. — already correct in current file.

### 2026-03 — Phase 7A (Parity & Stability)

- **Settings page**: Now a client component. Loads workspace name/settings from `GET /api/workspaces/:id` on mount. Saves to `PATCH /api/workspaces/:id`. `handleSave` dispatches to workspace/agent/api-keys branches. API Keys section converted to info panel pointing to AI Providers page + env var reference (keys live in process.env, not workspace settings).
- **PATCH /api/workspaces/:id**: Deep-merges settings (read-modify-write) so saving agent settings does not wipe personality/cost-ceiling and vice versa. 404 returned if workspace not found.
- **AI Providers fallback chain**: `fallbackOrder: ProviderKey[]` state added. Up/down buttons reorder configured providers. Persisted to `workspace.settings.aiProviders.fallbackOrder`. Loaded back on mount.
- **Insights/Memory browser**: Converted from server component to client component. Memory semantic search via `GET /api/memory/search`. Run improvement cycle button → `POST /api/memory/improvements/run`. Per-entry Apply buttons → `POST /api/memory/improvements/:id/apply`.
- **Telegram setup wizard**: `TelegramWizard` component in channels/page.tsx. 3-step: (1) BotFather guide, (2) token paste + live verify via `api.telegram.org/bot:token/getMe`, (3) webhook secret. Generic raw fields still used for Slack/Discord/etc.
- **GripVertical in fallback chain**: Was decorative only. Replaced with ▲▼ buttons that call `moveFallback(key, -1|1)` — no DnD dependency needed.

### 2026-03 — Phase 7A UX Polish

- **Approvals page**: `PendingDecision` from Redis `owd:*` keys, rendered with risk banners (low/medium/high/critical). Polling every 5s in page, 10s in sidebar. Sidebar badge uses `NEXT_PUBLIC_DEFAULT_WORKSPACE` env var since it runs client-side.
- **Sidebar badge pattern**: For future notification-style badges on nav items, follow `href === '/target' && count > 0` conditional pattern already in sidebar.
- **Task cancel**: `_cancel-button.tsx` is a client component within a server-rendered page — uses `router.refresh()` not `window.location.reload()` for proper RSC cache invalidation.
- **First-run gate**: `isFirstRun()` in `page.tsx` is async, timeout-wrapped. Always returns `false` on API error to prevent redirect loops. Only on home route, not layout, to avoid impacting all dashboard page loads.
- **Marketplace install error propagation**: `handleInstall` now throws on non-ok response; `IntegrationCard` catches and sets `installError` state displayed inline.

### 2026-03 — Phases 21-24 (Persistent Workers, SDK Bridge, OWD→SSE, Worker Observability)

- **Persistent Worker Pool v2** (`packages/agent/src/plugins/persistent-pool.ts`): Message-based host bridge handles `sdk_call` messages from workers and routes to real services. Dispatch map: `storage.*` → Redis (key: `ext:<pluginName>:<key>`), `memory.*` → `storeMemory`/`searchMemory`, `connections.*` → `installedConnections` table join, `events.publish` → `eventBus.publish`, `tasks.create` → `@plexo/queue push()`.
- **Activation SDK v2** (`packages/agent/src/plugins/activation-sdk.ts`): All capability stubs replaced with real `bridge()` calls. Takes `HostBridge = (method, args) => Promise<unknown>`. `nullBridge` throws; real bridge wired via postMessage in worker context. Storage uses correct `ttlSeconds` field name (from SDK types). Memory uses `tags` not `type` in read options.
- **Sandbox Worker v2** (`packages/agent/src/plugins/sandbox-worker.ts`): `makeMessageBridge()` posts `sdk_call` to host and awaits `bridge_reply` via `_bridgePending` map. Full persistent protocol: `activate` / `invoke` / `bridge_reply` / `terminate`. Ephemeral fallback preserved via `workerData` path.
- **OWD → SSE push**: `requestApproval()` now calls `eventBus.emitSystem(TOPICS.OWD_PENDING, record)` after writing to Redis. API `index.ts` subscribes to `TOPICS.OWD_PENDING` on server start and calls `emitToWorkspace(workspaceId, { type: 'owd.pending', data })`. Dashboard SSE clients receive `owd.pending` events in real time — no polling needed for approval banner.
- **Worker stats in /health**: `kapsel.workers` array in health response shows `{ pluginName, activatedAt, toolCount }` for each live persistent worker. Import: `@plexo/agent/persistent-pool`.
- **CORS fix**: `PUBLIC_URL=https://plexo.yourdomain.com` in `.env.local` was blocking browser requests from `localhost:3000`. Fixed CORS to always allow localhost origins in allowedOrigins Set, plus `PUBLIC_URL` value. Browser debug page can now fetch `/health`.
- **AUTH_SECRET**: Added to `apps/web/.env.local` — required by Auth.js v5 to suppress `MissingSecret` log noise. Same value as `SESSION_SECRET`.
- **`task_source` enum**: Added `'extension'` value via `ALTER TYPE task_source ADD VALUE IF NOT EXISTS 'extension'`. Schema updated. Persistent pool temporarily uses `'api'` source until migration is applied to all environments.
- **Event bus `TOPICS`**: Added `OWD_PENDING = 'plexo.owd.pending'` and `OWD_RESOLVED = 'plexo.owd.resolved'` to constants. `@plexo/agent/event-bus` added as a package export.
- **Drizzle migration journal**: No Drizzle migration journal table exists — DB was initialized directly from SQL files. Migrations are tracked manually. No journal sync needed.
- **Migration drift → 500 on `db.select()`**: When a schema column exists in Drizzle types but not in the DB (unapplied migration), `db.select().from(table)` throws a Postgres "column does not exist" error caught as a 500. The symptom is a working `/health` (uses raw SQL COALESCE) but 500 on any route using broad `db.select()`. Fix: apply the missing SQL manually via `docker exec -i <postgres-container> psql -U plexo -d plexo`. Verify with `information_schema.columns`. Migrations `0012_token_budgets.sql` (cost_ceiling_usd, token_budget on tasks; cost_ceiling_usd on sprints) and `0013_mcp_tokens.sql` (mcp_tokens table) were applied this way on 2026-03-05.

### 2026-03 — AI provider credential encryption

- **Root cause**: `workspaces.settings.aiProviders.providers[*].apiKey` was stored as plaintext JSONB. `GET /api/workspaces/:id` returned it unredacted.
- **Fix**: New route file `apps/api/src/routes/ai-provider-creds.ts` — `GET /workspaces/:id/ai-providers` returns redacted blob (sentinel `__configured__` in place of key values); `PUT /workspaces/:id/ai-providers` encrypts plaintext values via `encrypt(key, workspaceId)` (AES-256-GCM, workspace-scoped) before writing to DB.
- **Sentinel merge**: On PUT, if an incoming provider's apiKey or oauthToken is the sentinel string, the existing encrypted value is preserved rather than overwritten. This means the UI can omit sending previously-saved keys and they survive a save.
- **Agent-loop**: `loadWorkspaceAISettings()` now calls `loadDecryptedAIProviders(workspaceId)` instead of reading `workspaces.settings` directly. Keys arrive already decrypted.
- **Health check**: `pingAnthropic()` likewise routes through `loadDecryptedAIProviders` — no more plaintext DB read.
- **Workspace GET**: `GET /api/workspaces/:id` strips `aiProviders` from the settings object before responding. Credentials only flow through the `/ai-providers` sub-route.
- **UI**: AI Providers settings page now loads from `GET /ai-providers` and saves to `PUT /ai-providers`. After a successful save, key input fields are cleared (server holds the encrypted value; no need to re-display it).

### 2026-03 — Security hardening pass (all routes)

- **UUID validation on all path/query params**: Added `UUID_RE` gates to `tasks.ts`, `sprints.ts`, `workspaces.ts`, `plugins.ts`, `members.ts`, `cron.ts`, `memory.ts`, `connections.ts`. Every route that accepts an `id`, `workspaceId`, `userId`, or similar now returns 400 before touching the DB.
- **Input validation on POST bodies**: `tasks.ts` validates `type` against `VALID_TASK_TYPES` (coding/deployment/research/ops/opportunity/monitoring/report/online/automation) and `source` against `VALID_TASK_SOURCES` (matches `task_source` enum). `sprints.ts` adds `repo`/`request` length caps (500/4000 chars). `workspaces.ts` adds `name` length cap (200 chars) and UUID check on `ownerId`.
- **`queue/index.ts`**: Added `'extension'` to `source` union type — was missing despite being in the DB enum. Persistent pool was hitting a TS error via `tasks.create` sdk bridge call.
- **`chat.ts` TS2367**: Removed dead `=== 'failed'` check — `task_status` enum has no failed value (tasks go queued→claimed→running→blocked|cancelled|complete).
- **`oauth.ts` TS2353**: Removed stray `token_type: 'Bearer'` field from `storeAnthropicTokens()` call — not in the function's input type.
- **Anthropic OAuth token (sk-ant-oat01-*)**: These are Claude.ai/Claude Code session tokens, NOT Anthropic API credentials. They are NOT authorized against `api.anthropic.com`. `testProvider()` now short-circuits immediately with a clear explanation when an `sk-ant-oat` token is passed, instead of silently failing with "invalid x-api-key". Users must either use the OAuth popup flow ("Connect with Claude.ai" button) or a real API key from console.anthropic.com (`sk-ant-api03-*`).
- **`behavior.ts`**: UUID validation on workspaceId/ruleId path params, allowlist on `type` field, format enforcement on `key` (alphanumeric/underscore, max 80 chars), length cap on `label` (max 200 chars). This was the only route missing the UUID pattern that all other routes already followed.

### 2026-03 — Merged Agent + Behavior settings pages

- **`cost_ceiling_usd` missing column**: Migration `0012_token_budgets.sql` existed but hadn't run. Applied manually with `DATABASE_URL=... pnpm tsx src/migrate.ts` in `packages/db`. Fixed `GET /api/tasks`, `/api/sprints`, `/api/dashboard/activity` all returning 500.
- **Merged settings pages**: `/settings/agent` now contains 4 tabs — Identity, Behavior, Limits, History. The standalone `/settings/behavior` route now redirects to `/settings/agent?tab=behavior`.
- **Fixed bug — agentPersona + systemPromptExtra**: These fields were fetched in the old Behavior page but never rendered (no JSX input). Now surfaced in the Behavior tab as two plain textareas ("Who is this agent?" and "What should the agent know about your stack?").
- **Fixed bug — delete rule button invisible**: `opacity-0 group-hover:opacity-100` on the trash icon requires `group` class on the parent — the parent div now has `className="group ..."`.
- **Sidebar**: Removed the `Behavior` nav entry since it's now a tab under Agent.
- **UX simplification**: Behavior tab shows Persona + Context textareas first (average user path). Advanced layered rules are collapsed inside an accordion below. Inheritance view remains available for power users.
- **Limits tab improvements**: Replaced the raw `0.7` auto-approve threshold float with a human-readable dropdown (Auto-approve / Ask when uncertain / Always ask). Weekly spend cap shows `$` prefix and "per week" suffix. All fields now have plain-English descriptions.

### 2026-03 — Local Instance Flashing (Multiple Agents)

- **Root Cause**: Running multiple terminal agents executing `pnpm dev` or `tsx watch` concurrently spawns duplicate Next.js / API servers. These fight over port 3000 and Hot Module Replacement (HMR) WebSockets, causing constant `[Fast Refresh]` loops and UI flashing (e.g., the sidebar/nav rapidly appearing and disappearing).
- **Resolution**: Ran `killall -9 node tsx turbo next pnpm` to cleanly tear down all servers, then executed a single `pnpm dev` process. Next.js HMR stabilized (settling at ~600ms per build-up) without infinite refresh loops.
