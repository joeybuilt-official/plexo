# Database & Migrations

> Applies to Plexo's PostgreSQL/pgvector schema and Drizzle migration history.

## Boundary

- The database is a Frameworks & Drivers detail. Repository/query adapters stay outside pure rules.
- The schema source is `packages/db/src/schema.ts`; migrations live in `packages/db/drizzle/` and bookkeeping lives in `packages/db/drizzle/meta/_journal.json`.
- Use `@plexo/db` and the API repository boundary. Never pass Drizzle rows or query builders into inward logic.

## Schema changes

- Make every schema change through a migration. Do not edit a live database with a GUI, console, or ad-hoc `ALTER`.
- Change `packages/db/src/schema.ts` first, then generate with `pnpm db:generate`.
- Review generated SQL in `packages/db/drizzle/`; do not author a migration from scratch or use `DRAFT_*.sql` as a migration.
- Migrations are forward-only. Never edit or delete one that may be merged or applied; fix it with a new migration.
- Treat destructive SQL, type narrowing, and data rewrites as operator-gated changes.

## Apply and verify

- Apply with `pnpm db:migrate`, the repository's forward migration command. Never use `pnpm db:push` or `drizzle-kit push` against live data.
- Never use reset, force, accept-data-loss, or schema-sync variants to unblock a migration.
- After an operator applies a migration, verify the expected object in PostgreSQL's catalog or with a targeted query. Do not infer success from CLI output alone.
- `pnpm --filter @plexo/db db:check-drift` is the existing drift check; run it when a schema or migration history change requires it.

## Data writes

- Validate at the boundary before writing.
- Prefer parameterized Drizzle queries or repository methods over interpolated SQL.
- Update rows with `UPDATE`; do not delete and reinsert user-visible data.
- Keep backfills idempotent, bounded, and resumable.

## Verification reality

Migration generation, SQL review, apply, and catalog verification remain explicit gates. Do not claim a migration-integrity CI check unless one is added and wired into the existing workflows.
