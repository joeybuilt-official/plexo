# Architecture

## Overview

Plexo is a monorepo built with pnpm workspaces and Turborepo. The architecture enforces strict package boundaries to maintain isolation between concerns.

## Package Dependency Graph

```
                    ┌──────────────┐
                    │  apps/web    │
                    │  (dashboard) │
                    └──────┬───────┘
                           │ uses
                    ┌──────▼───────┐
                    │ packages/ui  │
                    │ (components) │
                    └──────────────┘

                    ┌──────────────┐
                    │  apps/api    │────────────────┐
                    │  (express)   │                │
                    └──┬──────┬────┘                │
                       │      │                     │
              uses     │      │ uses           uses │
          ┌────────────▼┐  ┌──▼──────────┐   ┌─────▼──────┐
          │ packages/   │  │ packages/   │   │ packages/  │
          │ agent       │  │ queue       │   │ sdk        │
          └──────┬──────┘  └──────┬──────┘   └────────────┘
                 │                │
            uses │           uses │
          ┌──────▼────────────────▼──────┐
          │        packages/db           │
          │    (schema + migrations)     │
          └──────────────────────────────┘
```

## Critical Boundaries

### SDK Isolation Wall
`packages/sdk` is a public API. Plugins depend on it exclusively. It must **never** import from `packages/agent`, `packages/db`, or any internal package. Breaking changes require a semver major bump.

### Plugin Isolation
Plugins run in Node.js worker threads. They communicate with the core process via a structured message protocol. A plugin crash is contained within its worker — the main process continues uninterrupted.

### Database Access
Only `packages/db`, `packages/queue`, and `packages/agent` may access the database. The web dashboard communicates exclusively through the API or Next.js server actions — never through direct DB imports.

## Data Flow

```
User Message → Channel Adapter → Message Router → Agent Core
  → Planner: creates execution plan
  → Executor: runs steps with tool calls
  → Verifier: checks post-conditions
  → Notifier: sends result back through channel
  → Ledger: records outcome for memory + billing
```

## Technology Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 22 | LTS, native ES modules, worker threads |
| Language | TypeScript strict | Type safety across package boundaries |
| Framework (web) | Next.js 15 App Router | SSR, server actions, file-based routing |
| Framework (api) | Express 5 | Mature, lightweight, async middleware |
| ORM | Drizzle | Type-safe, lightweight, migration tooling |
| Auth | Auth.js v5 | Provider ecosystem, session management |
| Database | PostgreSQL 16 + pgvector | Relational + vector search in one |
| Cache | Valkey (Redis-compatible) | Task state, feature flags, pub/sub |
| Reverse proxy | Caddy 2 | Auto-HTTPS, zero-config TLS |
| Build | Turborepo | Monorepo task orchestration, caching |
| Styling | Tailwind CSS v4 | Utility-first, design system tokens |
| Components | shadcn/ui | Composable, customizable, accessible |
test
