# Code Style & Patterns

> Applies to all source changes. Match nearby code before introducing a new convention.

## Before writing

- Read the target module and its closest sibling first.
- Prefer an existing file and pattern over a new abstraction.
- Decide the architecture layer before choosing a directory.
- Do not add unrequested refactors, dependencies, or compatibility paths.

## Verified Plexo conventions

| Concern | Rule |
| --- | --- |
| Exports | Library modules use named exports; framework entrypoints may use required default exports. |
| Internal imports | `apps/web` uses `@web/*`; workspace packages use package aliases such as `@plexo/db` and `@plexo/ui`; otherwise follow nearby relative imports. |
| Shared types and constants | Keep them in the owning package; public SDK contracts live under `packages/sdk/src/types/`, agent constants under `packages/agent/src/constants.ts`, and persistence types under `packages/db/src/`. |
| File and symbol naming | TypeScript files are mostly kebab-case; React symbols use PascalCase; functions and variables use camelCase; Python uses snake_case; Go uses Go naming. Preserve the nearest package convention. |
| API boundary | No single typed client exists. Use `apps/web/src/lib/api-server.ts` for server-side web calls, `apps/web/src/lib/swr.ts` and feature clients for browser calls, and extend the nearest existing client rather than adding a raw call in a reusable component. |
| Persistence boundary | API repositories under `apps/api/src/repositories/` backed by `@plexo/db`; package-local persistence follows the existing repository/port pattern. |
| Mechanical checks | `pnpm format:check` and `pnpm lint`. |

Use the formatter and linter rather than hand-arguing quotes, semicolons, or line width.

## Boundaries

- Business rules do not import ORM, HTTP, UI, queue, filesystem, or vendor code; see `clean-architecture.md`.
- Values shared across a boundary come from one owning module. Do not duplicate status, role, MIME, event, or capability unions.
- When existing code crosses a boundary directly, do not widen that gap in new code; record the gap instead of hiding it with a new convention.

## Structure

- One responsibility per file.
- Three similar lines beat a premature abstraction.
- When removing the last caller of a route, screen, export, feature flag, or config key, search string and dynamic references before deleting the now-unreachable code.
