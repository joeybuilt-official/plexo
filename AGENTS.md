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
packages/agent     → packages/db, packages/queue, packages/storage (never packages/sdk)
packages/ui        → no internal dependencies
apps/api           → packages/agent, packages/db, packages/queue, packages/sdk
apps/web           → packages/ui only (no direct DB or agent access)
plugins/core/*     → packages/sdk only (never packages/db or packages/agent)
```

## Source of Truth
- The canonical repo is always the source of truth.
- All changes go: local → `git push origin main` → server pulls from GitHub.
- Never edit files directly on a production server.
- Deploy: `export SOURCE_COMMIT=$(git rev-parse HEAD) && docker compose -f docker/compose.yml -f docker/compose.override.yml build <service> && docker compose -f docker/compose.yml -f docker/compose.override.yml up -d <service>`
- `docker/compose.override.yml` is gitignored — operator customizations (external Postgres, custom ports) go there and survive `git pull`.
- `/opt/plexo/docker/.env` is a symlink to `/opt/plexo/.env` — do not break this or `POSTGRES_PASSWORD` won't substitute.

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

## Deploy sequence (non-negotiable)
1. Commit locally
2. `git push origin main`
3. **STOP**: Ask for explicit user permission before deploying to the VPS.
4. Single SSH command: `export SOURCE_COMMIT=$(git rev-parse HEAD) && docker compose -f docker/compose.yml -f docker/compose.override.yml build <service> && docker compose -f docker/compose.yml -f docker/compose.override.yml up -d <service>`


Rules:
- `git pull` and `docker compose build/up` MUST be in the same SSH invocation, chained with `&&`.
- Never issue `docker compose build` or `up -d` as a separate follow-up SSH command — that skips the pull.
- Never edit files directly on the server.
- If the SSH connection drops mid-deploy, re-issue the full sequence from step 3.

## Dev Environment

### Ports
- Web (Next.js): 3000 (localhost only)
- API (Express): 3001 (localhost only)
- Postgres: 5432 (localhost only in dev; Docker-internal in prod)
- Redis: 6379 (localhost only in dev; Docker-internal in prod)
- If port conflicts arise locally, change via `.env.local` + `playwright.config.ts`.

### Dev login
See `.agents-local.md` (gitignored — operator-specific, not committed).

### Running locally
```bash
# API (terminal 1)
DATABASE_URL=postgresql://plexo:<password>@localhost:5432/plexo \
  REDIS_URL=redis://localhost:6379 PORT=3001 \
  ANTHROPIC_API_KEY=... ANTHROPIC_CLIENT_ID=... ENCRYPTION_SECRET=... \
  pnpm --filter @plexo/api exec tsx src/index.ts

# Web (terminal 2)
pnpm --filter @plexo/web dev
```

## Licensing

Plexo is licensed under AGPL-3.0-only (GNU Affero General Public License v3.0).
Copyright (C) 2026 Joeybuilt LLC.

All new source files must include the SPDX header:
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

Do not introduce dependencies with licenses incompatible with AGPL-3.0 (e.g., proprietary licenses, SSPL, or licenses with additional restrictions). Check new dependencies before adding them.

## Known Issues
*None.*

---

### 2026-03 — UI: "Live Conversation" Mode Overhaul

- **Status**: Implemented.
- **Problem**: Voice interaction felt disjointed. Text-to-Speech (TTS) and Speech-to-Text (STT) were separate toggles, forcing users to manually manage turn-taking.
- **Solution**: Replaced passive voice toggles with a unified "Live Conversation" mode.
- **Features**:
    - **Autonomous Turn-Taking**: Linked the `useTTS` `onEnd` callback directly to the microphone activation (`voice.start()`). The agent speaks, finishes, and then immediately re-opens the mic for the user.
    - **Interruption Support**: Manually activating the microphone or toggling Live Mode off immediately cancels any active speech synthesis via `window.speechSynthesis.cancel()`.
    - **Unified State**: Introduced `isLiveMode` in `ChatContent` as the single source of truth for conversational flow.
    - **UI Refinement**: Removed the "History" link from the header. Moved the "Live Conversation" toggle from the top header to the message input area (near the microphone and attachment buttons) for better accessibility. Added an amber pulse indicator to the toggle.
    - **Home Dialogue Integration**: Added "Live Mode" toggle to the `QuickSend` dashboard component. Activating it starts the mic immediately; submission deep-links to the chat page with `?live=1` to maintain session continuity seamlessly.
    - **Session Stability**: Refactored `useTTS` to use stable callbacks and refs for state tracking, ensuring that live conversation loops don't break during long-running agent tasks (preventing stale closures on the `speak` function). Added a 500ms auto-start watch to the mic when in Live Mode and idle.
- **Lesson**: Conversational UI should aim for zero-latency turn-taking. The agent shouldn't just "talk"; it should "listen" automatically when it stops talking.

---

### 2026-03 — Light/Dark Mode (Feature-Flagged, Pending Design Review)

- **Status**: Implemented, gated behind `NEXT_PUBLIC_THEME_TOGGLE=true`. Toggle and Appearance settings page section are invisible until the flag is set.
- **Architecture**: `next-themes` already installed. `ThemeProvider` wraps the app in `layout.tsx`; `defaultTheme` changed from `"dark"` → `"system"`, `storageKey="plexo-theme"`. `suppressHydrationWarning` on `<html>` was already present.
- **Tailwind v4**: Dark mode class variant declared via `@variant dark (&:where(.dark, .dark *))` in `globals.css`. This is Tailwind v4 syntax — VS Code's CSS linter flags it as unknown (ignore, PostCSS handles it correctly).
- **Light palette**: Defined in `.light { }` block in `globals.css`. Overrides surface, border, and text tokens only. Accent colors (azure, amber, red), radius, and font tokens are unchanged. **Provisional — do not ship to users until design approves.**
- **Raw `zinc-*` classes**: Many sidebar and dropdown components use `zinc-800`, `zinc-700`, etc. directly. These are hardcoded dark values — they will not adapt to light mode automatically. Light mode refinement requires a component-level pass once the palette is approved.
- **Toggle placement**: `ThemeToggle` (sun/moon icon) placed in the desktop sidebar footer (next to copyright) and in the mobile top header. Both render `null` when the flag is unset.
- **Settings Appearance section**: `AppearanceSection` added to `/settings` page as a tab. Gated via both the flag check in `ThemeToggle.tsx` and a `flagged: true` filter on the `SECTIONS` array.
- **To activate for design review**: Set `NEXT_PUBLIC_THEME_TOGGLE=true` in `.env.local` and restart the dev server.
- **To ship**: Remove the `if (process.env.NEXT_PUBLIC_THEME_TOGGLE !== 'true') return null` guards from `theme-toggle.tsx` and delete the `flagged` filter from `settings/page.tsx`.

---

### 2026-03 — Agent: Browser Tools & Capability Awareness

- **Status**: Implemented.
- **Problem**: The agent was declining simple web-based requests (e.g., "Set up social media profiles") because it didn't see specific integrations for those services in the "Active Connections" list, despite having access to a full browser.
- **Solution**: 
    - **Capability Manifest**: Updated `manifestToPromptBlock` to explicitly state "Web Automation: ENABLED" and clarify that browser tools can be used for any website interaction.
    - **Planner rules**: Added mandatory rules to the planner's system prompt forbidding task rejection based on missing service listings.
    - **Robust Fallbacks**: Guaranteed that `browser_*` tools are always present in the planner's fallback manifest if the database connection fails.
- **Lesson**: Don't let the existence of specific "high-level" integrations (APIs) blind the agent to its "low-level" capabilities (Browser). Browser automation is the ultimate universal fallback.

---

### 2026-03 — P0: Every Task Failed — OpenAI Responses API Rejects discriminatedUnion Schema

- **Root cause**: `planTask()` in `packages/agent/src/planner/index.ts` called `generateObject()` with a Zod `discriminatedUnion` schema (`anyOf` in JSON Schema). OpenAI's Responses API (`@ai-sdk/openai@3.x` default) requires the top-level schema to be `type: "object"` — a discriminated union produces `type: null` ("None"), which the API rejects with HTTP 400: `Invalid schema for response_format 'response': schema must be a JSON Schema of 'type: "object"', got 'type: "None"'`.
- **Why the fallback didn't trigger**: The catch block checked `errMsg.includes('response format')` but the actual error text was `response_format` (underscore, not space) — the string match never fired. Even if it had, the `withFallback()` wrapper only retries on rate-limit/timeout errors — a 400 is non-retryable and propagates immediately, bypassing the inner catch entirely.
- **Impact**: Every task queued against a workspace with OpenAI as primary provider was blocked immediately in the planning phase. All 30+ prior tasks have `status: blocked` with this error.
- **Fix**: Replaced `generateObject` with `generateText` + explicit JSON shape instructions in the prompt, universally. `generateText` works on every provider without schema format restrictions. The fallback try/catch block is removed — there's nothing to fall back from.
- **Lesson**: `generateObject` with `discriminatedUnion` / `anyOf` schemas is not portable across providers. Always use `generateText` + JSON prompting for structured outputs that need to work on OpenAI, Anthropic, and others. Add the JSON shape as a concrete example in the prompt — LLMs follow examples better than abstract schemas.

---

### 2026-03 — Chat Experience: Over-Clarification, Confirmation Theater, Bad Descriptions

- **Root cause 1 (Conversation system prompt)**: The system prompt explicitly told the model to "ask clarifying questions first" and "only agree to start a task or project when the scope is clear." This made the model interrogate users instead of answering.
- **Fix 1**: Replaced with a direct, no-nonsense system prompt: never ask for confirmation before answering, never ask clarifying questions unless genuinely ambiguous and a reasonable assumption cannot be made, act immediately on jokes/trivia/creative requests.
- **Root cause 2 (Confirmation theater)**: TASK intent triggered a `confirm_action` response requiring the user to click a button before anything happened. Every task required an extra confirmation — even when the user had already said "yes" multiple times in conversation.
- **Fix 2**: TASK now auto-queues server-side immediately. No confirmation step. The user says "do it" → it does it. Only PROJECT still shows one confirm (because it spins up a multi-step sprint worth saving before commit).
- **Root cause 3 (Bad task description)**: The `description` passed to `execute-action` was the raw user utterance at the moment of confirmation — "No. Just freaking do it." became the task and project description stored in the DB.
- **Fix 3**: Before queuing, the API runs a description synthesizer LLM call that crafts a clean, third-person task description from the full conversation context. The frustrated utterance is discarded; the actual intent is captured.
- **Root cause 4 (Classifier too aggressive)**: "Tell me a joke" was classified as TASK. The classifier was biased toward action over conversation.
- **Fix 4**: Classifier now has explicit rule: jokes, `"Tell me X"`, `"What is X"`, short confirmations after CONVERSATION exchanges → always CONVERSATION. TASK requires explicit, unambiguous request for a multi-step deliverable.
- **Lesson**: A chat experience is only as good as its system prompt. Advisory or hedging language in the system prompt produces an advisory, hedging model. The prompt must be prescriptive and prohibitive.

---

### 2026-03 — P0 Kill-Chain: Every Task Failed at ≤4 Tool Steps + Assets Never Visible

- **Root cause 1 (Step limit)**: `SAFETY_LIMITS.maxConsecutiveToolCalls` was hardcoded to 4. Vercel AI SDK v6 `stopWhen: stepCountIs(4)` stops the model after exactly 4 steps — before any realistic task could complete. Every non-trivial task (research, writing, code) requires 8–20+ steps minimum.
- **Fix 1**: Raised to 25. Retry loop restarts up to 3× if model fails to call `task_complete` — total ceiling is 75 tool calls per task.
- **Root cause 2 (Invisible assets)**: `write_asset` saved files to `/tmp/plexo-assets/{taskId}/`. The chat UI never fetched that endpoint. The task detail page never fetched it. Assets were saved but had zero surface — the user only ever saw the 1-3 sentence `outcomeSummary`.
- **Fix 2**: On `complete` SSE event in `pollReply`, chat page fetches `/api/v1/tasks/{taskId}/assets` and attaches files to the message. `AssetCard` component renders them inline with expand/copy. Task detail page (`/tasks/[id]`) fetches assets server-side in `fetchAssets()` and renders a "Deliverables" panel above the stats row.
- **Root cause 3 (No write_asset mandate)**: System prompt said "Use write_asset to save deliverables" as advisory text. Model often skipped it and put content directly in `task_complete.summary`, which is capped at a sentence or two.
- **Fix 3**: For all non-coding-sprint task types (research/writing/ops/data/marketing/general/automation), system prompt now includes a `MANDATORY OUTPUT REQUIREMENT` block that explicitly forbids calling `task_complete` before at least one `write_asset` call.
- **Root cause 4 (Shell env secrets exposure)**: `spawnSync` spread `process.env` into the subshell, including `ENCRYPTION_SECRET`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, etc. Any shell command the agent ran could exfiltrate these.
- **Fix 4**: Allowlist (`SAFE_ENV_KEYS`) replaces the spread. Only safe env vars (PATH, HOME, USER, GIT_*, PNPM_HOME, NODE_ENV, TMP*) are passed to the subshell.
- **Lesson 1**: `maxConsecutiveToolCalls: 4` is a silent kill switch. If this constant changes, every task silently dies. Check it before debugging perceived "agent stupidity".
- **Lesson 2**: Asset creation ≠ asset visibility. Trace the full path: agent tool → filesystem → API endpoint → UI fetch → render. Any break in that chain means the user sees nothing.
- **Lesson 3**: Advisory system prompt language for output requirements is ignored. Use mandatory phrasing with explicit prohibition on calling task_complete without the required tool call.

---

### 2026-03 — Installer Bottleneck: Database Authentication Fails on First Run

- **Root cause**: `migrate` service depended on `postgres: service_healthy`, but `pg_isready` in the healthcheck only verifies the server is accepting connections for the user/db; it does NOT verify password readiness during the initial entrypoint setup. If `migrate` fired during a transient state in the initialization script (e.g., while re-reading hba.conf), it failed with `28P01` (password authentication failed).
- **Secondary cause (Stale Volumes)**: If a user runs `install.sh` multiple times, it generates a new `POSTGRES_PASSWORD` in `.env`. However, Docker's `pgdata` volume is already initialized with the *old* password. The database does not update its internal credentials when the environment variable changes; `migrate` then fails because it uses the new password from `.env` against the old password in the volume.
- **Fix 1 (Retry Loop)**: Added a robust retry loop to `packages/db/src/migrate.ts`. It now attempts up to 30 connections with 2s delays. Specific handlers for `28P01` (Auth), `3D000` (DB missing), and `ECONNREFUSED` ensure it waits for the initialization script to finish.
- **Fix 2 (Troubleshooting Hints)**: If authentication fails for more than 10 attempts, `migrate` now prints an explicit "BOTTLENECK IDENTIFIED" block in the logs with three clear steps: check for stale volumes, verify `.env` parity, and check `docker/compose.yml` string interpolation.
- **Lesson**: `depends_on: service_healthy` is not a guarantee of "application readiness" for authentication. Always implement application-level retries in migration/seeding scripts that run during initial deployment.

---

### 2026-03 — migrate exits 1: SyntaxError invoking .bin/tsx shell wrapper as JS

- **Root cause**: `docker/migrate.sh` called `node --max-old-space-size=200 /app/packages/db/node_modules/.bin/tsx src/migrate.ts`. The `.bin/tsx` file is a POSIX shell shebang wrapper (`#!/bin/sh`, starts with `basedir=$(dirname...)`). Node.js interprets that shell script as JavaScript, hitting `SyntaxError: missing ) after argument list` on the first line.
- **Impact**: `docker-migrate-1` exited code 1. All services with `depends_on: migrate / condition: service_completed_successfully` (`caddy`, `api`, `web`) stayed in `Created` state. VPS unreachable.
- **Fix**: `migrate.sh` now invokes `node_modules/tsx/dist/cli.mjs` directly — the actual ESM entrypoint — bypassing the shell wrapper. Stable regardless of pnpm hoisting.
- **Lesson**: Never pass a `.bin/` wrapper as an argument to `node <path>`. `.bin/` files are shell scripts. Use the package's real `dist/` entrypoint when calling via `node`.

---

### 2026-03 — Migration Container 32GB Swap Runaway

- **Root cause 1 (`deploy.resources.limits` not enforced)**: All services in `docker/compose.yml` used `deploy.resources.limits` for memory and CPU caps. This key is **Swarm-only** — `docker compose up` (non-Swarm) ignores it entirely. The migrate container had no enforced memory cap.
- **Root cause 2 (No Node heap limit)**: `migrate.sh` called `tsx src/migrate.ts` with no `NODE_OPTIONS` or `--max-old-space-size`. V8 could grow unbounded into swap.
- **Root cause 3 (No process timeout)**: If the migration hung (wrong credentials, locked DB, corrupt state), it ran indefinitely. `restart: "no"` prevented restarts but didn't bound the initial run.
- **Fix 1**: Replaced all `deploy.resources.limits` blocks with top-level `mem_limit` / `memswap_limit` which Docker enforces via cgroup in all run modes. Migrate gets `mem_limit: 256m` + `memswap_limit: 512m` — 256m RAM + up to 256m swap, hard ceiling.
- **Fix 2**: `migrate.sh` now passes `node --max-old-space-size=200` before tsx. V8 stays within cgroup limits.
- **Fix 3**: `packages/db/src/migrate.ts` has a 5-minute `setTimeout` that exits 1 if migrations don't complete.
- **Fix 4**: Migration runner now logs file count on start and elapsed time on completion. No more silent black box.
- **Fix 5**: `MIGRATIONS_DIR` env var (set in compose.yml but never read) is now actually read in `migrate.ts`.
- **Fix 6**: Removed dead `docker/migrate.mjs` (used a different Drizzle adapter than the runner that actually executes).
- **Fix 7**: Deploy command now includes `-f docker/compose.override.yml` so user customizations survive deploys.
- **Lesson**: `deploy.resources.limits` requires Swarm mode. For enforced limits in `docker compose up`, use top-level `mem_limit` + `memswap_limit` at the service level.

---

### 2026-03 — Cost Tracking: Double-Write Round 2 (work_ledger)

- **Root cause**: `agent-loop.ts` inserted a `work_ledger` row on task completion. `executor/index.ts` also inserted a `work_ledger` row after `executeTask()` returned. The executor row contains richer data (`deliverables jsonb`, `wall_clock_ms`) but both rows carried the same `cost_usd`. Net effect: every task reported 2x real cost in dashboard and intelligence aggregate queries.
- **Fix**: Removed the insert from `agent-loop.ts`. Executor is now the single canonical writer. `agent-loop.ts` owns only `api_cost_tracking` (weekly accumulator). No schema change needed.
- **Verification**: Task `01KKC6A7` post-fix has exactly 1 `work_ledger` row; pre-fix tasks `01KKC538` and `01KKC5VY` each have 2.
- **Lesson**: There must be exactly one write path to any accumulator. When `executor` and `agent-loop` both had ledger writes, neither was clearly authoritative — a classic case where two reasonable places to put the write results in double-counting.

---

### 2026-03 — Cost Tracking: Double-Write + Wrong-Table Reads

- **Root cause 1 (double-write)**: `executor/index.ts` wrote to `api_cost_tracking` at end of `executeTask()`. `agent-loop.ts` then wrote the same amount again after calling `completeTask()`. Every completed task's cost was counted exactly twice in the weekly accumulator.
- **Root cause 2 (wrong reads)**: `dashboard.ts` (`GET /dashboard/summary`) and `tasks.ts` (`GET /tasks/stats/summary`) both read `SUM(cost_usd)` from the `tasks` table, not `api_cost_tracking`. They also filtered by `created_at` instead of `completed_at`, so tasks created in a prior week but completed this week could be missed, and vice versa. The `tasks` table cost column is a denormalized field for per-task display only — it is NOT the authoritative cost accumulator.
- **Fix 1**: Removed the `api_cost_tracking` upsert from `executor/index.ts`. Agent-loop is now the single canonical writer for that table.
- **Fix 2**: Agent-loop upsert upgraded to also set `alerted_80` flag (80% ceiling threshold tracking).
- **Fix 3**: Dashboard and task stats endpoints now read from `api_cost_tracking` (current ISO week, using `date_trunc('week', NOW())::date`) and `work_ledger` (all-time total, filtered by `completed_at`) — the same sources used by the Intelligence page introspection.
- **Lesson**: There must be exactly ONE write path to any accumulator table. Any read of a cost/budget number must come from the same table the write path targets. If the Intelligence page shows correct numbers but the dashboard shows $0, trace the query — it's reading the wrong table.

---

### 2026-03 — P0: VPS Offline (Missing Migration due to .gitignore)

- **Root Cause**: A blanket `*.sql` ignore in the root `.gitignore` (intended for DB dumps) accidentally matched Drizzle's migration scripts. While the files existed on the development machine, they were never committed to GitHub. When the VPS pulled the code and rebuilt, the migration container found the journal expecting `0022_overjoyed_killmonger.sql` but the file was missing from the build context.
- **Fix**: Updated `.gitignore` to explicitly allow migration files (`!**/drizzle/*.sql`) and committed the missing files. 
- **Lesson**: Be extremely specific with double-star patterns in `.gitignore`. Extension-based ignores (like `*.sql`) are dangerous in monorepos where those extensions are part of the application logic. 
- **Verification**: `curl https://<vps>/health` → `200 OK`.


### 2026-03 — Sprint Failures Silent in Chat + No Sentry

- **Root cause 1 (silent failure)**: `chat.ts /execute-action` spawns `runSprint()` fire-and-forget. The `.catch` only called `logger.error`. No `recordConversation` error turn, no SSE event — user saw the conversation bubble stuck at "Project created" with no indication of failure.
- **Root cause 2 (specific error)**: The chat intent classifier sometimes classifies a request as `code` category. Without a `repo` in the body (chat UI has no repo field), `runCodeSprint` immediately throws `'repo is required for code category'`. The fire-and-forget catches this but nobody sees it.
- **Root cause 3 (no Sentry)**: `@sentry/node` was in `package.json` with no init code anywhere. Zero errors were ever captured.
- **Fix 1**: `execute-action` `.catch` now: (a) calls `captureException` → Sentry, (b) calls `recordConversation` with `status: 'failed'` + `errorMsg`, (c) emits `chat_error` SSE event to the workspace.
- **Fix 2**: When `category === 'code'` and no `repo` is in the body, `execute-action` downgrades to `'general'` before creating the sprint row. Code-category sprints without a repo can never succeed; better to run as general.
- **Fix 3**: `apps/api/src/sentry.ts` created. `initSentry()` called at top of `index.ts` after env validation. `SENTRY_DSN` added to `ENV_SPEC` as optional. `captureException` imported in `sprint-runner.ts` and `chat.ts`. Uncaught exceptions and unhandled rejections also captured.
- **Lesson**: Fire-and-forget promises MUST have `.catch` handlers that report back to the user — logging alone is not sufficient. Any async failure that originates from a user action must complete the user-facing feedback loop.

---

### 2026-03 — Intelligence Page: Provider Status / Cost / Memory all Non-Functional

- **Root cause 1 (Provider status)**: `buildIntrospectionSnapshot` used `!!cfg.apiKey` to determine if a provider was configured. But the GET endpoint returns the sentinel string `__configured__` instead of real keys. Truthy sentinel → every provider that had ever been saved showed as `ACTIVE`, regardless of whether the real key was valid or removed.
- **Fix 1**: `isConfigured` now requires `cfg.apiKey !== '__configured__'` (real decrypted key), or `cfg.baseUrl`, or `cfg.status === 'configured'` without an apiKey (keyless providers like Ollama). The no-provider fallback is marked `unconfigured` unless an `activeProvider` argument is passed (meaning a task is actively running).
- **Root cause 2 (Weekly budget always $0)**: `agent-loop.ts` called `completeTask()` which only updates the `tasks` row. Neither `api_cost_tracking` (weekly accumulator) nor `work_ledger` (per-task audit row) were ever written. Both tables existed in the schema but no code path inserted into them on task completion.
- **Fix 2**: After `completeTask()`, agent-loop now: (1) upserts the current-week `api_cost_tracking` row using `ON CONFLICT DO UPDATE SET cost_usd = cost_usd + EXCLUDED.cost_usd`, (2) inserts a `work_ledger` row. Also fixed the introspection cost query to filter to the current ISO week with `date_trunc('week', NOW())::date` instead of `ORDER BY week_start DESC LIMIT 1`.
- **Root cause 3 (Memory always empty)**: `recordTaskMemory()` existed in `packages/agent/src/memory/store.ts` but was never called after task completion. The only way entries accumulated was via the 6h consolidation cron.
- **Fix 3**: `agent-loop.ts` now calls `recordTaskMemory()` non-fatally after every successful task, populating `memory_entries` with `type='task'`.
- **Root cause 4 (Refresh button useless)**: The refresh endpoint was cached for 30s in Redis with no bypass. Clicking Refresh within 30s returned the same cached response.
- **Fix 4**: `GET /introspect?bust=1` skips the Redis cache entirely. The Refresh button now appends `?bust=1` to the URL.
- **Lesson**: Tables in the schema are not automatically evidence that writes happen. Always trace the write path from agent-loop/executor to verify cost/memory/ledger tables are actually populated.

---

## Memory System Architecture

- **`memory_entries` (PostgreSQL + pgvector)**: Stores semantic memories with 1536-dim embeddings (OpenAI `text-embedding-3-small`). Falls back to ILIKE text search when no OpenAI key.
- **`workspace_preferences`**: Key/value store with confidence scores. Used for learned patterns (language, test framework) and user-set behavioral rules.
- **Redis cache**: `plexo:memory:<workspaceId>:search:*` (5m TTL), `plexo:memory:<workspaceId>:prefs` (10m TTL). Invalidated on every write.
- **MEMORY intent in chat**: When a user says "remember X", "always do Y", it goes to memory. It does not queue a task.
- **Rules application**: Every task plan context fetches high-confidence preferences from `workspace_preferences` and includes them in the system prompt.
- **Consolidation cron**: Runs every 6h via `scheduleMemoryConsolidation()` called at startup. Visible in the Cron UI as 'Memory consolidation' (seeded per workspace on startup). Also manually triggerable via `/api/v1/memory/improvements/run`.

---

### 2026-03 — Empty Conversations Table / Missing Chat History

- **Root cause**: `GET /api/v1/conversations?groupBySession=true` executes raw SQL via `db.execute()`. This raw query returned columns in `snake_case` (e.g., `created_at`, `workspace_id`), but the frontend's `ConversationItem` strictly expected `camelCase` properties (`createdAt`, `workspaceId`). This caused `createdAt` to be `undefined`, producing an "Invalid Date" grouping in the UI, crashing or rendering an empty conversation history. The conversations *were* successfully saved, but the UI couldn't display them.
- **Fix**: Mapped the `rawRows` array objects from `snake_case` to `camelCase` in `apps/api/src/routes/conversations.ts` before returning them as JSON.
- **Lesson**: `db.execute(sql...)` returns raw DB column names based on the Postgres mapping, bypassing Drizzle's camelCase keys. When migrating from `db.select()` to `db.execute()`, field properties must always be explicitly mapped to avoid breaking the frontend contract.

## Bug Post-Mortems

### 2026-03 — ENCRYPTION_SECRET env var mismatch

- **Root cause**: `apps/api/src/crypto.ts` and `packages/agent/src/connections/crypto-util.ts` both read `process.env.PLEXO_ENCRYPTION_KEY`. But `docker/compose.yml` injects the secret as `ENCRYPTION_SECRET` (matching `.env.example`). The names were never aligned. Every `encrypt()` / `decrypt()` call threw `'PLEXO_ENCRYPTION_KEY not set'` at runtime.
- **Symptom on fresh install**: All `PUT /api/workspaces/:id/ai-providers` requests silently returned 500. AI provider credentials were never persisted. Health check and agent loop reported `not_configured` regardless of what key was entered in the UI. Tasks blocked immediately.
- **Compounding factor**: `ENCRYPTION_SECRET` was absent from `apps/api/src/env.ts` `ENV_SPEC`, so startup logged no error or warning. The issue was completely invisible until the `/debug` page was checked.
- **Fix**: Renamed env var read in both crypto files from `PLEXO_ENCRYPTION_KEY` → `ENCRYPTION_SECRET`. Added `ENCRYPTION_SECRET` to `ENV_SPEC` as a required field with a 32-char minimum — process now exits(1) on missing or short value.
- **Lesson**: Any env var read by application code must have a corresponding entry in `env.ts` ENV_SPEC. Crypto vars are required, not optional.

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-09 | Agent self-extension via `synthesize_kapsel_skill` | Enables agent to generate, persist, and activate its own Kapsel skills. Sandboxed (SDK-only), capability-gated, code validated before install |
| 2026-03-09 | Generated skills stored in Docker named volume `generated_skills` at `/var/plexo/generated-skills` | Survives container restarts; survives rebuilds if volume is not pruned |
| 2026-03-09 | `is_generated` flag on `connections_registry`, `isGenerated` in `plugins.settings` | Drives ✦ Custom badge in UI; no separate table needed |
| 2026-03-03 | Valkey over Redis | Open-source fork, API-compatible, production-stable, no license risk |
| 2026-03-03 | ULID over UUID | Lexicographically sortable, URL-safe, no coordination needed |
| 2026-03-03 | Express 5 over Fastify | Mature ecosystem, async middleware native, simpler mental model |
| 2026-03-03 | Pino over Winston | 10x faster, structured JSON native, built-in redaction |
| 2026-03-03 | Turborepo over Nx | Simpler config, faster cold starts, Vercel-maintained |

### Intelligent LLM Router (Pre-Build Audit)

- **Finding**: `DEFAULT_MODEL_ROUTING` in `registry.ts` is entirely static and explicitly marked as "Not runtime configurable."
- **Finding**: Model strengths (capabilities) are currently inferred via hardcoded string heuristics on model IDs (e.g. `llama -> open-source`) within `packages/agent/src/providers/knowledge.ts`.
- **Finding**: Model knowledge currently syncs from a free `openrouter/api` endpoint, not the proposed `Portkey-AI/models` JSON registry.
- **Convention/Decision**: The Intelligent LLM Router will transition to a 4-mode routing abstraction (Auto, BYOK, Mode Proxy, Override) based on dynamic cost vs. quality arbitration.
- **Decision (Gap)**: Credentials and routing are currently tightly coupled in `workspaces.settings.aiProviders`. A backwards-compatible migration path is required to decouple the 'vault' (keys) from the 'arbiter' (routing preferences).

### 2025-06 — Vercel AI SDK v6 Migration

- **ai@6 breaking changes**: `maxSteps` removed → use `stopWhen: stepCountIs(N)`. `usage.promptTokens/completionTokens` → `usage.inputTokens/outputTokens`. Tool definitions use `inputSchema:` not `parameters:`. `execute` receives `(input, options)`.
- **Ollama**: `ollama-ai-provider` is LanguageModelV1 only — incompatible with ai@6. Replaced with `@ai-sdk/openai-compatible` pointing at Ollama's `/v1` endpoint.
- **LanguageModel types**: `@ai-sdk/provider` is not a direct dep. Return type of `buildModel` uses `any` internally; generateText accepts all provider versions at runtime.
- **Tool execute typing**: Explicit parameter type annotations on execute callbacks cause TS overload mismatch. Let TypeScript infer from Zod `inputSchema`.

### Navigation & Settings Architecture

- **Sidebar groups**: Chat · Control · Agent · Settings · System. Collapsible, state persisted in `localStorage` under `plexo:sidebar:collapse`.
- **AI Providers page**: Two-panel layout. Primary selection, test connection, fallback chain display, collapsible model routing table.
- **Connections browser**: Backed by real `/api/connections/registry` + `/api/connections/installed`. Auth-type-aware install UI: OAuth2 opens popup via `window.open`, API key uses input fields + `POST /api/connections/install`.
- **DashboardRefresher**: SSE EventSource at `/api/sse?workspaceId=...` + `router.refresh()` on task events. Falls back to 15s polling on SSE failure. Reconnects after 5s. Mounted once in `(dashboard)/layout.tsx`.
- **Workspace resolver pattern**: `getWorkspaceId()` in `apps/web/src/lib/workspace.ts` — React `cache()` deduplicates within a render pass. Server components use `DEV_WORKSPACE_ID` fallback; client components use `NEXT_PUBLIC_DEFAULT_WORKSPACE`.

### Agent Executor

- **Persona**: `workspaces.settings` JSONB holds `agentName`, `agentPersona`, `agentTagline`, `agentAvatar`. Executor dynamic-imports from `@plexo/db` to read these at task start. Non-fatal try/catch — falls back to 'Plexo' name and empty persona prefix.
- **Sprint coding context**: When a task has `type: 'coding'` and `context.repo`/`context.branch`, the agent loop clones the target repo to a temp dir before dispatch. `ExecutionContext.sprintWorkDir` is the absolute path. Cleaned up in the `finally` block after task completes.
- **Shell tool**: Resolved against `ctx.sprintWorkDir` as default cwd. Timeout 60s, maxBuffer 2MB. PATH preserved from process.env.
- **read_file / write_file**: Resolve relative paths against `sprintWorkDir`.

### Sprint Planner

- **AGENTS.md injection**: For `category: 'code'` sprints, the planner fetches `/contents/AGENTS.md` from the target repo via GitHub API (base64-decoded) and injects up to 4000 chars into the planning prompt. Non-fatal — planner proceeds without it if fetch fails.
- **Capability manifest**: Injected before planning. Tasks requiring uninstalled capabilities (video, image, audio) are substituted with text/document deliverables.
- **Execution waves**: Topological sort on `depends_on` — tasks in the same wave are independent and dispatched in parallel.

### Workspace Membership

- **`workspace_members` table**: composite unique `(workspace_id, user_id)`, roles enum `member_role` = owner/admin/member/viewer. Migration 0007 backfills existing owners.
- **`workspace_invites` table**: 48-char random hex token, optional `invited_email`, role, 7-day `expires_at`, `used_at`/`used_by_user_id` for single-use enforcement.
- **Members router**: mounted at `/api/workspaces/:id/members` with `mergeParams: true`. Params require explicit cast `(req.params as { id: string }).id` due to Express 5 typing.
- **`/invite/[token]` page**: standalone accept flow outside dashboard layout.

### Persistent Workers & SDK Bridge

- **Persistent Worker Pool**: Message-based host bridge handles `sdk_call` messages from workers. Dispatch map: `storage.*` → Redis (key: `ext:<pluginName>:<key>`), `memory.*` → storeMemory/searchMemory, `connections.*` → installedConnections table, `events.publish` → eventBus, `tasks.create` → queue.
- **OWD → SSE push**: `requestApproval()` emits `TOPICS.OWD_PENDING` after writing to Redis. API subscribes and pushes `owd.pending` events to dashboard SSE clients in real time.
- **Migration drift → 500**: When a schema column exists in Drizzle types but not in the DB, `db.select()` throws a Postgres "column does not exist" caught as 500. Fix: apply missing SQL manually via `docker exec -i <postgres-container> psql -U plexo -d plexo`.

### AI Provider Credential Encryption

- **`workspaces.settings.aiProviders.providers[*].apiKey`** was stored as plaintext JSONB. Fixed: `PUT /workspaces/:id/ai-providers` encrypts via `encrypt(key, workspaceId)` (AES-256-GCM, workspace-scoped). `GET` returns sentinel `__configured__` instead of key values.
- **Sentinel merge**: On PUT, if an incoming provider's apiKey/oauthToken is the sentinel string, the existing encrypted value is preserved.
- **Anthropic OAuth token (sk-ant-oat01-*)**: These are Claude.ai session tokens, NOT Anthropic API keys. Not authorized against `api.anthropic.com`. `testProvider()` short-circuits with a clear message when one is passed. Use the OAuth popup flow or a real API key from console.anthropic.com (`sk-ant-api03-*`).

### Security

- **UUID validation**: `UUID_RE` gates on all path/query params in tasks, sprints, workspaces, plugins, members, cron, memory, connections routes. Returns 400 before touching DB.
- **Input validation**: `type` validated against `VALID_TASK_TYPES`, `source` against `VALID_TASK_SOURCES`. Length caps on `repo` (500), `request` (4000), `name` (200).
- **`behavior.ts`**: UUID validation on workspaceId/ruleId, allowlist on `type`, alphanumeric/underscore enforcement on `key` (max 80), length cap on `label` (max 200).

### Developer Tooling Notes

- **`tsx watch` + stdin**: Do NOT start `tsx watch` via `&` without `< /dev/null`. If stdin is a pipe, tsx reads Enter keys from subsequent shell commands and hot-starts mid-request. Always use `cmd < /dev/null > logfile 2>&1 &`.
- **Multiple local agents**: Running multiple concurrent `pnpm dev` or `tsx watch` processes fight over port 3000 and HMR WebSockets, causing UI flashing. Run `killall -9 node tsx turbo next pnpm` then a single `pnpm dev`.

### Version & Release Infrastructure
 
 - **Version source of truth**: `NEXT_PUBLIC_APP_VERSION` injected in `apps/web/next.config.ts` from root `package.json`. Sidebar and dashboard footer read from this env var.
 - **Version check API**: Use `/releases?per_page=1` not `/releases/latest` — the latter returns 404 when no non-prerelease exists and skips pre-releases entirely.
 - **`scripts/self-update.sh`**: git pull → pnpm install → db:migrate → docker compose build + up. Checks `PLEXO_MANAGED=true` to skip Docker steps on managed instances.
 - **Redis keys**: `plexo:system:latest_version` (1h TTL, cleared after update).
 
 - **2026-03 — Infinite Update Loop**: 
   - **Root cause 1 (Clock Skew)**: The VPS server clock and the client clock (where commits were authored) were slightly skewed. When `system.ts` triggered a `docker compose build`, the `.build-time` generated on the VPS was physically *earlier* than the literal commit date as registered by git on the laptop. Since the system compared `commitDate > buildDate`, the server perpetually believed it was behind the commit it had just pulled and built.
   - **Fix 1**: Ripped out the clock comparison logic. We explicitly bake the exact SHA hash of the commit directly into the docker container as a `.source-commit` file using `docker compose build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD)`. `system.ts` now reads `local.sourceCommit` and compares it directly against the GitHub `latestCommit.sha` string, bypassing clocks entirely.
   - **Root cause 2 (Arg Override Bug)**: Despite Fix 1, Docker Compose `v2` silently drops `--build-arg` references if the `compose.yml` file lists the arg under `build.args` without explicitly receiving them from an environment variable exported into the subprocess. Because `GIT_COMMIT` was set as an un-exported local variable in the subshell (`GIT_COMMIT=$(git rev-parse HEAD) && docker compose ...`), docker composed defaulted to using `unknown` and baked `"unknown"` into the container. Every subsequent comparison of `"unknown"` to a real commit hash failed, triggering the loop again.
   - **Fix 2**: Added the explicit `export` flag to the subshell (`export SOURCE_COMMIT=$(git rev-parse HEAD) && docker compose ...`) and explicitly added `SOURCE_COMMIT: ${SOURCE_COMMIT:-unknown}` to both the `api` and `migrate` build args in `docker/compose.yml`. This guarantees the arg is correctly resolved by Compose and passed into Dockerfile.api.

### GitHub Integration & Sprint Execution

- **GitHub tools in bridge.ts**: `create_branch`, `open_pr`, `merge_pr`, `list_issues`, `create_issue`, `get_ci_status`, `read_file`, `push_file`. All implemented against the GitHub REST API using the workspace's stored PAT from `installed_connections`.
- **Token resolution**: `resolveGitHubToken(workspaceId)` checks `installed_connections` table first, falls back to `GITHUB_TOKEN` env var.
- **`GitHubClient.getFileContent(path, ref)`**: Fetches and base64-decodes a file from any ref. Returns null on 404 or error.
- **`git` in Docker**: API container (`Dockerfile.api`) installs git via `apk add --no-cache git` on the Alpine base — required for sprint repo clones inside the container.

### Intelligent LLM Router (Execution Complete)

- **Finding**: Implemented `IntelligentRouter` inside `packages/agent/src/providers/router.ts`.
- **Finding**: Modified `syncModelKnowledge()` inside `packages/agent/src/providers/knowledge.ts` to strictly loop `ALLOWED_PROVIDERS` and pull pricing configuration via `Portkey-AI/models` registry index mapping, enforcing Layer 1 architecture.
- **Finding**: Upgraded `IntelligentRouter.handleAuto` to map Task types directly against Portkey metrics natively via highly optimized PostgreSQL JSONB containment (`@>`) querying.
- **Finding**: `resolveModel()` now unpacks `WorkspaceAISettings` recursively into disjoint `VaultConfig` and `RouterConfig`, ensuring the router operates solely on parameter references and never exposes credential strings to raw arbitration traces.
- **Finding**: Implemented `console.info` structured telemetry in `resolveModel` that exports `router.arbitration.resolved` specifying task, mode, model, and cost per million.
- **Finding**: `workspaces.settings.aiProviders` decoupling resolved via on-read lazy migration in `apps/api/src/routes/ai-provider-creds.ts`. Legacy schema is split invisibly into strictly typed `vault` (keys, OAuth tokens) and `arbiter` (inference settings) entries, achieving zero-downtime architectural isolation backwards-compatible with active client payloads.

### 2026-03 — Empty Insights & Self-Improvement Failure

- **Root cause 1 (Self-Improvement LLM failure)**: When the agent found no new patterns, the LLM returned an empty object `{}` instead of `{"proposals": []}`. This crashed the Zod schema validation with a `TypeValidationError`, swallowing the cycle silently as 0 proposals.
- **Fix 1**: Chained `.default([]).catch([])` onto the Zod `proposals` array and instructed the LLM prompt to explicitly return an empty array if no clear patterns exist.
- **Root cause 2 (Memory completely empty on load)**: `GET /api/v1/memory/search` enforced a strict 400 error if the `q` parameter was empty. The `InsightsPage` UI prevented search entirely without a query. As a result, users never saw their historical memory entries natively.
- **Fix 2**: Dropped the empty `q` check in the API. Modified `store.ts` to skip both ILIKE strings and embedding when the query is empty, substituting it for a straight order-by `memory_entries.createdAt` query. Finally, `InsightsPage.tsx` now calls a search with `q=` on mount to fetch the latest context natively.

### 2026-03 — Overly Strict Capability Blocking in Planner

- **Root cause**: The system prompt for the task planner (`packages/agent/src/planner/index.ts`) strictly mandated a `clarification` response if a requested capability was "NOT listed in the manifest above". This caused the agent to reject abstract, text-document, or real-world tasks (like "Plan a party") because physical capabilities (event organization, venue selection) were obviously missing from the digital tool manifest.
- **Fix**: Updated the planner's `RULES` to limit the strict denial *only* to required digital media capabilities (e.g., video_generation, voice_synthesis). For abstract, physical, or real-world tasks, the planner is now instructed to leverage its text and research capabilities to deliver a strategy/schedule document, and optionally prescribe integrations rather than blocking the task.
- **Lesson**: Do not let strict capability constraints inadvertently gate real-world text-planning workflows. When providing an LLM a list of explicit limitations, clearly distinguish between "cannot do this digital action" versus "cannot do this physical action".

---

### 2026-03 — Chat Experience: Vague Campaign Auto-Queueing (Plexo Improvement)

- **Root cause**: The intent classifier was over-eager, categorizing vague noun phrases (e.g., "Wayfinders S2 Campaign") as `TASK` or `PROJECT`. This triggered immediate, low-context queueing or "Project created" confirmations before the user had provided any strategic direction.
- **Fix 1 (Classifier)**: Updated `CLASSIFY_SYSTEM` in `apps/api/src/routes/chat.ts` to explicitly route vague campaign/project names to `CONVERSATION`. It now only classifies as `TASK` or `PROJECT` if there is an unambiguous verb-driven request for a multi-step deliverable.
- **Fix 2 (Prompt)**: Updated the conversational system prompt to recognize when a large initiative is mentioned. It now proactively asks for: (1) Strategy/Approach, (2) Timeline, (3) Goals/Priorities, and (4) Channels.
- **Fix 3 (Flow)**: The agent is instructed to gather these details first and *then* ask the user if they'd like to initiate a formal project.
- **Lesson**: Vague noun phrases are invitations for a strategy session, not a trigger for execution. The agent must bridge the gap between "I have an idea" and "Do this work" by first asking for the 'Why' and 'When'.



---

### 2026-03 — Plexo Image Handling & Visual Capabilities

- **Status**: Implemented.
- **Features**:
    - **Incoming Media**: Telegram adapter now parses incoming photos, extracts URLs/captions, and persists them to the `conversations` table via a new `attachments` JSONB column.
    - **Outgoing Media**: `task_complete` events now include a list of generated assets. The Telegram adapter automatically fetches these assets and sends them back as photos with captions.
    - **Web Agent Visuals**: Added `web_screenshot` (using Google Chrome) and `image_search` (Google-based scraping) tools to the agent's builtin toolkit.
    - **Chat UI Enhancements**: `MessageBubble` and `AssetCard` now render image previews and thumbnails for both user and agent messages. Conversation history correctly restores images from the database.
- **Lesson**: Image handling in a text-driven agent requires a clear "attachment" contract between the executor, the log, and the delivery adapter. Never assume the model will mention the image in text; always poll the asset directory on completion.

---

### 2026-03 — UI: GitHub Repository Selection (Dropdown vs Manual Input)

- **Problem**: Users were forced to manually type the full repository name (e.g., `owner/repo`) when connecting an existing project in Code Mode. This was error-prone and required looking up the repo on GitHub first.
- **Fix (API)**: Added `GET /api/v1/connections/github/repos` which resolves the workspace's GitHub connection, decrypts the token, and fetches the user's repository list directly from the GitHub API.
- **Fix (UI)**: Replaced the raw text input with a searchable premium dropdown (Combobox).
- **Features**:
    - **Search-as-you-type**: Real-time filtering of fetched repositories.
    - **Auto-branching**: Selecting a repository automatically pre-fills the "Target Branch" field with the repository's `defaultBranch` (e.g., `main`).
    - **Metadata Visibility**: Displays repository descriptions and "Private" badges in the selection list.
- **Lesson**: Reducing friction in the tool-setup phase directly improves the "time-to-first-task" metric. Always prefer authenticated lookups over manual entry for connected services.

---

### 2026-03 — GitHub Branch Selection & Creation

- **Problem**: Users were forced to manually type the target branch name in the repository setup dialog, increasing friction and the risk of typos for existing branches.
- **Fixes**:
    - **Branch Introspection**: Added `/api/v1/connections/github/branches` endpoint to fetch real-time branch lists for connected repositories.
    - **Interactive Selector**: Replaced the "Target Branch" text input with a searchable combobox populated with existing branches.
    - **Creation Toggle**: Integrated a "Create new branch" workflow within the dropdown, allowing users to switch between selecting existing branches and defining new ones.
    - **Smart Defaults**: The selector automatically fetches and selects the repository's default branch (`main`, `master`, etc.) upon repository selection.
- **Lesson**: UI completeness matters during "First Mile" configuration. Providing discoverable options (like existing branches) prevents user anxiety about "guessing" correctly.

---

### 2026-03 — Security: Repository Hardening & Path Sanitization

- **Problem**: A security audit identified hardcoded development passwords, absolute local paths (`/home/dustin/...`), and tracked visual assets that contained sensitive UI states from a private instance.
- **Fixes**:
    - **De-coupling credentials**: One-off scripts moved to `scripts/internal/` (ignored) and updated to use `process.env.DATABASE_URL`.
    - **Asset isolation**: Screenshots moved to `images/internal/` (ignored).
    - **Path sanitization**: `fix.sh` and other shell utilities updated to use relative paths.
    - **Debug protection**: Enforced `DEBUG_TOKEN` check on all `/api/debug/*` routes via new middleware.
    - **Inclusion logic**: `.gitignore` updated to strictly exclude `.claude/`, `.cache/`, `tmp/`, and build artifacts like `.gradle/`.
- **Lesson**: Development scripts and visual assets are common leak points for sensitive context. Always assume one-off files will be accidentally committed and protect them with directory-level `.gitignore` rules. Root-level `.env` is the only source of truth for credentials.

---

### 2026-03 — P0/P1: Chat Crash + Prompt Optimization Failure (Drizzle SQL & Intent Resolution)

- **Root cause 1 (SQL Crash)**: `chat.ts` used the `?` operator in a Drizzle `sql` template for a JSONB containment check (`strengths ? 'reasoning'`). Drizzle (Postgres driver) interpreted `?` as a bind parameter placeholder. Since no parameter was provided for it, the query crashed the entire request with a 500 error.
- **Fix 1**: Replaced `?` with the `@>` JSONB operator: `sql`${modelsKnowledge.strengths} @> '["reasoning"]'::jsonb``. This avoids the character-level ambiguity in the SQL template.
- **Root cause 2 (Intent Mismatch)**: "Optimize this prompt" was being classified as a `TASK`. This auto-queued it as a background worker job. However, the specialized "First Principles Prompt Optimizer" logic resides in the `CONVERSATION` system prompt (allowing for an interactive interview). Background workers cannot talk back to the user to conduct an interview; they just produce a single outcome summary.
- **Fix 2**: Forced "Optimize this prompt" to `CONVERSATION` intent in the `CLASSIFY_SYSTEM` rules. Added explicit examples to the classifier.
- **Root cause 3 (Missing Task Types)**: Intent classification categories like `writing`, `marketing`, `data`, and `general` were being used but were missing from BOTH the database `task_type` enum and the agent's `TaskType` union. This would cause runtime validation errors if those intents were ever queued as tasks.
- **Fix 3**: Added `writing`, `marketing`, `data`, and `general` to `packages/db/src/schema.ts` and `packages/agent/src/types.ts`. Updated `QUALITY_RUBRICS` in `packages/agent/src/constants.ts` with appropriate dimensions for each new type.
- **Root cause 4 (Broken Conversation Loop)**: The `message` handler was missing the logic to return a synchronous reply for `CONVERSATION` intents, instead defaulting to a "Confirm to continue" response.
- **Fix 4**: Implemented the synchronous `withFallback -> generateText` flow for `CONVERSATION` intents within the `POST /api/chat/message` handler.
- **Lesson**: `sql` templates with `?` are a landmine in Drizzle. Always use `@>` or escape `??` if the driver supports it. Secondly, interactive specialized behaviors (like prompt optimization) MUST be conversations, not tasks, to allow for the feedback loop.
### 2026-03 — UI: Artifact Workbench & Split-Pane Layout

- **Status**: Implemented.
- **Problem**: Code-related interactions (terminals, file trees, diffs) felt disruptive to the chat flow. Users had to toggle modes or look at bottom tabs, losing context of the conversation.
- **Solution**: Implemented a "Split-Pane" architecture with a persistent but retractable "Artifact Workbench" on the right side of the chat.
- **Features**:
    - **Split-Pane Layout**: Flexible 60/40 split between Chat and Workbench. Supports pinning (side-by-side) or overlay (mobile/floating) modes.
    - **Global Mode Switcher**: Moved mode selection (Chat, Code, Insights) to a new global Header for easier multi-tasking.
    - **Condensed Thought Traces**: Replaced verbose tool-call logs in chat with compact, horizontal pill-based progress indicators ("steps"). Clicking a step focuses the relevant context in the Workbench.
    - **Unified Context**: The Workbench maintains separate tabs for a Terminal, File Tree, Test Results, and Live Previews, all synced to the active agent task.
    - **Traceability**: Enhanced agent "thinking" transparency by showing granular status (queued/running/complete/failed) for every sub-step in real-time.
- **Architecture**:
    - Introduced `ArtifactWorkbench` as the primary sidecar component.
    - Added `ModeSwitcher` and global `Header` to the dashboard layout.
    - Refactored `ChatPage` to manage the workbench state (`isWorkbenchOpen`, `isPinned`, `workbenchContext`).
- **Lesson**: Complex agentic workflows require a secondary "surface" for technical context. The chat remains the place for intent and dialogue, while the Workbench handles the heavy lifting of code visualization and execution feedback.

### 2026-03 — UI/UX: Task & Project Finesse Overhaul

- **Status**: Implemented.
- **Problem**: Inconsistent status styling across components; Project views were over-indexed on code-centric layouts; Task lists lacked clear visual hierarchy and quick-action access.
- **Solution**:
    - **Centralized UI Tokens**: Created `@plexo/ui` with `StatusBadge` and `CategoryBadge` components. `STATUS_MAP` defines the source of truth for all status colors/icons.
    - **Premium Layouts**: Refactored `Tasks`, `Projects`, and `Dashboard` (CommandCenter) with consistent card designs, hover effects, and micro-animations.
    - **Category-Aware Detail Pages**: Project detail pages now adapt their default view based on the project category (e.g., Reports/Writing categories hide the "Code" tab by default and focus on "Deliverables").
    - **High-Density Telemetry**: Refactored `LiveDashboard` and `CommandCenter` to provide high-density system health and task status in a "neural link" aesthetic.
    - **Better Navigation**: Standardized breadcrumbs and status indicators across all dashboard sub-pages.
- **Lesson**: UI consistency is as important as logic. Using a centralized component library for "status" and "category" prevents design drift and makes the system feel much more robust.

### 2026-03 — UI/UX: Sidebar Navigation Indicators & Insights Overhaul

- **Status**: Implemented.
- **Problem**: Critical system states (blocked tasks, failed cron jobs, pending improvements) were buried, requiring multiple clicks to identify. The Insights page lacked prominence for its core value: improvement proposals.
- **Solution**:
    - **Sidebar Indicators**: Added real-time notification badges/dots to "Tasks" (blocked), "Memory/Insights" (pending improvements), "Cron Jobs" (failures), and "Workspace/Intelligence" (RSI anomalies).
    - **Group Pulses**: Navigation group headers (Work, Capabilities, System) now pulse when child items require attention, ensuring visibility even when groups are collapsed.
    - **Insights Layout**: Restructured `/insights` into a high-density two-column layout. Moved "Improvement Proposals" to a dedicated premium sidebar with filtered "Needs Review" pulses.
    - **Real-time Count Tracking**: Updated the sidebar's `fetchCounts` loop to fetch and deduplicate counts for all new indicator types.
- **Lesson**: Attention is a finite resource. If the system "needs" something from the user, it should signal that intent globally across the nav rather than waiting for the user to stumble upon the relevant page.
