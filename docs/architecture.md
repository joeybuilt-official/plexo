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

## Plexo Fabric v0.4.0 — Three Pillars

Plexo implements the Plexo Fabric Specification v0.4.0. The spec defines three distinct architectural pillars:

| Pillar | What it is | Manifest type |
|--------|-----------|---------------|
| **Connection** | Authenticated pipe to an external service. Inert on its own. | N/A (host-managed) |
| **Extension** | Capability package — functions, schedules, widgets, memory access. | `skill` · `channel` · `tool` · `connector` |
| **Agent** | Autonomous actor with a goal, planning loop, and identity. Orchestrates Extensions. | `agent` |

An Agent is NOT a subtype of Extension. An Extension does not think. An Agent does. An Agent picks up Extensions the way a person picks up tools.

The SDK (`packages/sdk`) defines the complete type system for Plexo Fabric v0.4.0 including entity schemas (§16), trust tiers (§17), audit trails (§18), data residency (§19), UserSelf (§20), DID identity (§21), A2A bridge (§22), escalation contracts (§23), model context (§24), and service discovery (§25).

## Critical Boundaries

### SDK Isolation Wall
`packages/sdk` is a public API. Extensions depend on it exclusively. It must **never** import from `packages/agent`, `packages/db`, or any internal package. Breaking changes require a semver major bump.

### Extension Isolation
Extensions run in Node.js worker threads. They communicate with the core process via a structured message protocol. An extension crash is contained within its worker — the main process continues uninterrupted.

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
