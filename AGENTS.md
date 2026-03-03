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

## Current State — Phase 1 Complete

### What's live
- Full monorepo scaffold: 7 packages, 2 apps, 7 plugin stubs
- Database schema: 21 tables defined in Drizzle, ready for migration
- Auth.js v5: credentials + GitHub OAuth configured
- API server: Express 5 with `/health`, SSE, request tracing, structured logging
- Dashboard: Next.js 15 with sidebar, 6-card grid, login/register pages
- Docker Compose: Postgres 16+pgvector, Valkey, Caddy reverse proxy
- `pnpm typecheck` passes 7/7 packages, 0 errors

### What's stubbed (throws NotImplementedError)
- All agent operations: pushTask, claimTask, completeTask, blockTask, sendMessage, startSprint, storeMemory, searchMemory
- Plugin SDK runtime: all methods log warnings and return no-ops
- Dashboard data: all cards show placeholder content
- API routes: `/api/tasks`, `/api/sprints`, `/api/connections/registry` return empty arrays
- Registration endpoint: form exists but `/api/auth/register` is not implemented

### What needs Docker stack to verify
- `pnpm db:migrate` on fresh Postgres
- End-to-end login flow
- `/health` with real service pings

### Phase 2 scope (next)
- Agent execution loop: plan → confirm → execute → verify → complete
- Real task queue processing (claim + run)
- Channel adapter framework (inbound/outbound message routing)
- Live `/health` checks against Postgres, Redis, AI provider
- Real credentials registration (bcrypt password hashing, DB insert)
- First unit tests (Vitest, TDD)
