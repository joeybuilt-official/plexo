# Plexo - Claude Code Guidelines

## Project Overview

Plexo is an open-source AI agent platform for autonomous task execution, persistent memory, model routing, and self-extending integrations.

**Core pillars**: safe autonomous execution; durable workspace memory; provider-neutral intelligence; extensible multi-channel interoperability.

## Tech Stack

- **Language / runtime**: TypeScript on Node.js >=22; Python FastAPI graph sidecar; Go 1.25 gmessages sidecar; Dart 3.12.2 / Flutter mobile client
- **Package manager**: pnpm 10.30.3 (`pnpm-lock.yaml`)
- **Client**: Next.js 16.2.6 + React 19.2.3 + Tailwind CSS 4 in `apps/web` and `apps/hub`; Flutter in `apps/mobile`; shared React components in `packages/ui`
- **Server**: Express API in `apps/api`; FastAPI/Graphiti sidecar; Go gmessages sidecar; Vercel AI SDK provider adapters
- **Data**: PostgreSQL + pgvector through Drizzle (`packages/db`); FalkorDB/Graphiti; Redis/Valkey
- **Workspace layout**: pnpm workspaces `apps/*`, `packages/*`, `extensions/core/*`, orchestrated by Turborepo

## Key Commands

| Purpose | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Dev | `pnpm dev` |
| Test | `pnpm test:all` |
| Typecheck | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Format check | `pnpm format:check` |
| Build | `pnpm build` |
| Architecture boundary check | `pnpm arch:check` |
| Generate migration | `pnpm db:generate` |
| Apply migration | `pnpm db:migrate` |

## Project Structure

```
apps/api/                 Express API, routes, application, domain, repositories
apps/web/                 Next.js dashboard and authenticated client
apps/hub/                 Next.js extension marketplace
apps/mobile/              Flutter native client
apps/gmessages/           Go Google Messages sidecar
apps/vision/              Node vision service and routes
packages/agent/           Agent loop, tools, memory, providers, executor
packages/db/              Drizzle schema, client, and forward migrations
packages/queue/           Queue ports, repositories, and Inngest wiring
packages/session-fabric/  Framework-free runner policy and use cases
packages/sdk/             Public Plexo SDK contracts
packages/ui/              Shared React UI components and tokens
extensions/core/          PEX extensions and bridges
services/graphiti-sidecar/ FastAPI/FalkorDB knowledge graph service
tests/                    Unit, integration, end-to-end, load, and chaos suites
scripts/                  E2E, parity, maintenance, and migration helpers
adr/                      Architecture decision records
```

## How We Work Together

`AGENTS.md` is user-owned and authoritative. Read it before changes. Read the applicable rule module before touching code.

@AGENTS.md

### Architecture
@.claude/rules/clean-architecture.md

### Process
@.claude/rules/workflow.md
@.claude/rules/quality-bar.md
@.claude/rules/git-workflow.md
@.claude/rules/documentation.md

### Code, tests, and failures
@.claude/rules/code-style.md
@.claude/rules/testing.md
@.claude/rules/error-handling.md

### Data and interfaces
@.claude/rules/api-design.md
@.claude/rules/database.md
@.claude/rules/data-modeling.md

### UI
@.claude/rules/frontend.md
@.claude/rules/design-system.md

### AI
@.claude/rules/ai-features.md

## Project Knowledge

Shared context lives in `docs/claude/`. Read `roadmap.md` (the overall plan) and `in-progress.md` (the next-up queue) first, then the relevant architecture, patterns, infrastructure, completed-work, and area docs.

## Project-Specific Rules

- Workspace isolation is a security invariant: authenticate and authorize workspace access before reading or writing workspace-owned data.
- One-way-door and irreversible actions remain human-gated; do not bypass the policy or approval surfaces for convenience.
- Route model calls through the existing provider routing and fallback paths; do not hardwire a vendor into feature logic.
- Schema changes start at `packages/db/src/schema.ts`, use generated Drizzle migrations, and apply through `pnpm db:migrate`; never use schema push against live data.
- Preserve unrelated worktree changes. This setup changes only `CLAUDE.md`, `.claude/**`, `docs/claude/**`, and append-only `.gitignore`.
