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

## Known Issues
*None.*

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
| 2026-03-03 | Drizzle over Prisma | No binary dependency, no generation step, SQL-native, smaller bundle |
| 2026-03-03 | Valkey over Redis | Open-source fork, API-compatible, production-stable, no license risk |
| 2026-03-03 | ULID over UUID | Lexicographically sortable, URL-safe, no coordination needed |
| 2026-03-03 | Express 5 over Fastify | Mature ecosystem, async middleware native, simpler mental model |
| 2026-03-03 | Pino over Winston | 10x faster, structured JSON native, built-in redaction |
| 2026-03-03 | Turborepo over Nx | Simpler config, faster cold starts, Vercel-maintained |

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

- **`tsx watch` + stdin**: Do NOT start `tsx watch` via `&` without `< /dev/null`. If stdin is a pipe, tsx reads Enter keys from subsequent shell commands and hot-restarts mid-request. Always use `cmd < /dev/null > logfile 2>&1 &`.
- **Multiple local agents**: Running multiple concurrent `pnpm dev` or `tsx watch` processes fight over port 3000 and HMR WebSockets, causing UI flashing. Run `killall -9 node tsx turbo next pnpm` then a single `pnpm dev`.

### Version & Release Infrastructure

- **Version source of truth**: `NEXT_PUBLIC_APP_VERSION` injected in `apps/web/next.config.ts` from root `package.json`. Sidebar and dashboard footer read from this env var.
- **Version check API**: Use `/releases?per_page=1` not `/releases/latest` — the latter returns 404 when no non-prerelease exists and skips pre-releases entirely.
- **`scripts/self-update.sh`**: git pull → pnpm install → db:migrate → docker compose build + up. Checks `PLEXO_MANAGED=true` to skip Docker steps on managed instances.
- **Redis keys**: `plexo:system:latest_version` (1h TTL, cleared after update).

### GitHub Integration & Sprint Execution

- **GitHub tools in bridge.ts**: `create_branch`, `open_pr`, `merge_pr`, `list_issues`, `create_issue`, `get_ci_status`, `read_file`, `push_file`. All implemented against the GitHub REST API using the workspace's stored PAT from `installed_connections`.
- **Token resolution**: `resolveGitHubToken(workspaceId)` checks `installed_connections` table first, falls back to `GITHUB_TOKEN` env var.
- **`GitHubClient.getFileContent(path, ref)`**: Fetches and base64-decodes a file from any ref. Returns null on 404 or error.
- **`git` in Docker**: API container (`Dockerfile.api`) installs git via `apk add --no-cache git` on the Alpine base — required for sprint repo clones inside the container.
