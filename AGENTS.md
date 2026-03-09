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

## Source of Truth
- The canonical repo is always the source of truth.
- All changes go: local → `git push origin main` → server pulls from GitHub.
- Never edit files directly on a production server.
- Deploy: `git pull origin main && docker compose -f docker/compose.yml build <service> && docker compose -f docker/compose.yml up -d <service>`
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
3. Single SSH command: `git pull origin main && docker compose -f docker/compose.yml build <service> && docker compose -f docker/compose.yml up -d <service>`

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

### 2026-03 — Cost Tracking: Double-Write + Wrong-Table Reads

- **Root cause 1 (double-write)**: `executor/index.ts` wrote to `api_cost_tracking` at end of `executeTask()`. `agent-loop.ts` then wrote the same amount again after calling `completeTask()`. Every completed task's cost was counted exactly twice in the weekly accumulator.
- **Root cause 2 (wrong reads)**: `dashboard.ts` (`GET /dashboard/summary`) and `tasks.ts` (`GET /tasks/stats/summary`) both read `SUM(cost_usd)` from the `tasks` table, not `api_cost_tracking`. They also filtered by `created_at` instead of `completed_at`, so tasks created in a prior week but completed this week could be missed, and vice versa. The `tasks` table cost column is a denormalized field for per-task display only — it is NOT the authoritative cost accumulator.
- **Fix 1**: Removed the `api_cost_tracking` upsert from `executor/index.ts`. Agent-loop is now the single canonical writer for that table.
- **Fix 2**: Agent-loop upsert upgraded to also set `alerted_80` flag (80% ceiling threshold tracking).
- **Fix 3**: Dashboard and task stats endpoints now read from `api_cost_tracking` (current ISO week, using `date_trunc('week', NOW())::date`) and `work_ledger` (all-time total, filtered by `completed_at`) — the same sources used by the Intelligence page introspection.
- **Lesson**: There must be exactly ONE write path to any accumulator table. Any read of a cost/budget number must come from the same table the write path targets. If the Intelligence page shows correct numbers but the dashboard shows $0, trace the query — it's reading the wrong table.


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
- **MEMORY intent in chat**: When a user says "remember X", "always do Y", "never Z" — detected by classifier, written directly to `memory_entries` (type=pattern) + `workspace_preferences` (key=user_instruction). No task queued.
- **Executor injection**: At task start, `getPreferences()` is called (Redis-backed). Non-empty rules are injected as `WORKSPACE RULES (always follow these)` block in the system prompt.
- **Consolidation cron**: Runs every 6h via `scheduleMemoryConsolidation()` called at startup. Visible in the Cron UI as 'Memory consolidation' (seeded per workspace on startup). Also manually triggerable via `/api/v1/memory/improvements/run`.

---

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
- **Finding**: Rebuilt Mode 3 ('proxy') inference router loop. `proxyFetch` now translates standard AI SDK fetch payloads dynamically into heavily guarded `PlexoInferenceRequestSchema` mapped bodies featuring live HMAC `X-Plexo-Signature` cryptographic bindings for secure downstream evaluation by the Plexo inference-gateway.
- **Finding**: `resolveModel()` now unpacks `WorkspaceAISettings` recursively into disjoint `VaultConfig` and `RouterConfig`, ensuring the router operates solely on parameter references and never exposes credential strings to raw arbitration traces.
- **Finding**: Implemented `console.info` structured telemetry in `resolveModel` that exports `router.arbitration.resolved` specifying task, mode, model, and cost per million.
- **Finding**: `workspaces.settings.aiProviders` decoupling resolved via on-read lazy migration in `apps/api/src/routes/ai-provider-creds.ts`. Legacy schema is split invisibly into strictly typed `vault` (keys, OAuth tokens) and `arbiter` (inference settings) entries, achieving zero-downtime architectural isolation backwards-compatible with active client payloads.

### 2026-03 — Empty Insights & Self-Improvement Failure

- **Root cause 1 (Self-Improvement LLM failure)**: When the agent found no new patterns, the LLM returned an empty object `{}` instead of `{"proposals": []}`. This crashed the Zod schema validation with a `TypeValidationError`, swallowing the cycle silently as 0 proposals.
- **Fix 1**: Chained `.default([]).catch([])` onto the Zod `proposals` array and instructed the LLM prompt to explicitly return an empty array if no clear patterns exist.
- **Root cause 2 (Memory completely empty on load)**: `GET /api/v1/memory/search` enforced a strict 400 error if the `q` parameter was empty. The `InsightsPage` UI prevented search entirely without a query. As a result, users never saw their historical memory entries natively.
- **Fix 2**: Dropped the empty `q` check in the API. Modified `store.ts` to skip both ILIKE strings and embedding when the query is empty, substituting it for a straight order-by `memory_entries.createdAt` query. Finally, `InsightsPage.tsx` now calls a search with `q=` on mount to fetch the latest context natively.
