# Clean Architecture

> Applies to every new code change. Dependencies point inward; framework, storage, queue, UI, and vendor code stays at the edge.

## The premise

Business rules should survive changes to Express, Next.js, Drizzle, Postgres, Graphiti, Flutter, and provider SDKs. Keep rules in plain modules where possible. Put I/O behind a port when a use case needs it, and compose concrete adapters at the edge.

## Plexo target map

This is a target-with-gaps map, not a claim that the existing repository is fully layered. The paths are the nearest verified roles; current gaps are recorded in `docs/claude/architecture.md`.

| Layer | Directory in Plexo | Rule |
| --- | --- | --- |
| Entities / Domain | `apps/api/src/domain/` | New domain rules stay framework-free. Shared core policy code belongs in `packages/agent/src/` or `packages/session-fabric/src/` only when it can remain free of outer imports. |
| Use Cases / Application | `apps/api/src/application/` | Operations and ports; new use cases do not accept Express requests, Drizzle rows, queue payloads, or vendor response shapes. |
| Interface Adapters | `apps/api/src/routes/` and `apps/api/src/repositories/` | Translate transport and persistence shapes, enforce boundary auth, and implement inward ports. `apps/web/src/app/api/` is the web adapter edge. |
| Frameworks & Drivers | `apps/api/src/infrastructure/`, `packages/db/`, `apps/web/`, `services/graphiti-sidecar/`, `apps/gmessages/` | Frameworks, ORM, migrations, databases, queues, SDKs, config, and composition roots. |

Each deployable app or shared package may need its own refinement of this map. Do not force one physical four-folder layout across the monorepo.

## Placement test

1. Changes because a Plexo business rule changed: Entities / Domain.
2. Orchestrates one application operation or authorization decision: Use Cases / Application.
3. Translates HTTP, persistence, queue, UI, or vendor shapes: Interface Adapters.
4. Changes because a framework, driver, or vendor changed: Frameworks & Drivers.

If a file answers two questions, split the rule from the integration before expanding it.

## Boundary rules

- Route handlers parse and authorize, call inward logic, then map the result. Do not put new business decisions in route handlers.
- Do not pass Drizzle rows, query builders, Express requests/responses, Next requests/responses, or queue payloads into pure rules.
- DTOs cross HTTP and process boundaries. Do not serialize a domain object directly as a public response.
- Validate shape and format at the adapter; enforce invariants in entities/use cases so jobs, CLI calls, and tests cannot bypass them.
- Declare an interface inward when the core needs database, clock, random ID, filesystem, queue, or HTTP access. Implement it outward.
- A port needs a real implementation and a test double, or a documented reason not to add one.

## Review checklist

- New code under `apps/api/src/domain/` has no outer imports.
- New use-case code under `apps/api/src/application/` does not import Drizzle, Express, Next.js, storage, queue, or vendor SDKs.
- Every workspace-scoped route authenticates and checks workspace membership before data access.
- Persistence stays behind repository adapters and `packages/db/`; provider and graph integrations stay at their adapter edges.
- A vendor swap should not require editing domain or use-case contracts.
- No new code widens an existing architecture gap without stating the boundary and follow-up in the change description.
