# Multi-Tenancy Architecture

## Current Approach: Application-Layer Isolation

Plexo uses **application-layer tenant isolation** rather than PostgreSQL Row-Level Security (RLS).

### How It Works

1. **Every workspace-scoped query includes an explicit `WHERE workspace_id = ?` clause.**
2. **The `ensureWorkspaceAccess` middleware** validates that the authenticated user is a member of the requested workspace before any route handler executes.
3. **Workspace membership** is stored in `workspace_members` and checked on every API request that includes a `workspaceId` parameter.

### Why Not RLS (Current Phase)

| Factor | Application-Layer | RLS |
|--------|------------------|-----|
| Query transparency | Explicit in code | Implicit via policies |
| Debugging | Straightforward — WHERE clauses visible | Requires `SET role` to reproduce |
| Migration complexity | Low — standard Drizzle ORM | High — policy DDL per table |
| Performance overhead | None beyond normal queries | Minor per-statement policy eval |
| Risk of bypass | Higher if middleware skipped | Lower — enforced at DB layer |

During beta, the codebase is evolving rapidly. RLS policies would need to be updated for every schema change, and debugging query-plan issues through policies adds friction.

### Safeguards

- **Middleware enforcement**: `ensureWorkspaceAccess` rejects requests where the user is not a workspace member. This runs before all workspace-scoped routes.
- **API key scoping**: API keys are scoped to a single workspace.
- **Audit logging**: All workspace data mutations are logged with userId and workspaceId.
- **No cross-workspace joins**: The application layer never performs joins across workspace boundaries.

### Post-Beta RLS Plan

Once the schema stabilizes (target: GA release), we plan to:

1. Add RLS policies to all workspace-scoped tables (`tasks`, `conversations`, `memory_entries`, `behavior_rules`, `artifacts`, etc.).
2. Set `app.current_workspace_id` via `SET LOCAL` in a transaction wrapper middleware.
3. Keep application-layer checks as defense-in-depth (belt and suspenders).
4. Run a migration that enables RLS on each table and creates `USING (workspace_id = current_setting('app.current_workspace_id')::uuid)` policies.

### Tables Requiring RLS (When Implemented)

- `workspaces` (owner-only write)
- `workspace_members`
- `tasks`
- `conversations`
- `memory_entries`
- `behavior_rules`
- `artifacts` / `artifact_versions`
- `cron_jobs`
- `session_logs`
- `work_ledger`
- `ai_provider_credentials`
- `installed_connections`
- `installed_extensions`
