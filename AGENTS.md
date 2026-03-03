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
