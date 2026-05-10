# Identity Architecture

## TL;DR

Plexo does not own user records. In the Joeybuilt SaaS fleet, all apps
(Plexo, Pushd, Fylo, Levio, Command Center) share a single identity store:
`pushd.auth.user`, managed by Better Auth.

Plexo's `plexo.public.users` table is a **postgres_fdw foreign table** that
projects `pushd.auth.user` into the plexo DB. Reads work. Writes are forbidden
by contract.

## Why

A user signs up once — through any Joeybuilt app — and is instantly recognised
by every other app. Their subscription, profile, and auth credentials live in
one place. This is non-negotiable for the SaaS fleet: splitting identity
across per-app tables creates drift, ghost users, and the 403-on-owner bug that
motivated this rewrite.

## How it works

```
┌────────────────────┐         ┌────────────────────┐
│  plexo database    │         │  pushd database    │
│                    │         │                    │
│  public.users ─────┼────────▶│  auth.user         │
│  (foreign table)   │  FDW    │  (real table)      │
│                    │         │                    │
│  workspaces        │         │  auth.session      │
│  workspace_members │         │  auth.account      │
│  …                 │         │                    │
└────────────────────┘         └────────────────────┘
```

Both databases live on the same Postgres instance (`postgres`) in the
Joeybuilt fleet, so cross-DB joins are cheap — latency is a few hundred
microseconds for the indexed id lookups we actually do.

`postgres_fdw` forwards SELECT statements to the remote DB. Drizzle sees
`users` as a regular table; the storage engine is what differs.

### Schema

`public.users` columns (mirrors `pushd.auth.user` exactly):

| column        | type        | notes                                |
|---------------|-------------|--------------------------------------|
| `id`          | text        | Better Auth id (current values are UUIDs) |
| `name`        | text        |                                      |
| `email`       | text unique |                                      |
| `emailVerified` | boolean   |                                      |
| `image`       | text        |                                      |
| `createdAt`   | timestamptz |                                      |
| `updatedAt`   | timestamptz |                                      |
| `role`        | text        | Better Auth `user` or `admin`        |
| `banned`      | boolean     |                                      |
| `banReason`   | text        |                                      |
| `banExpires`  | timestamptz |                                      |

Note the mixed case on a few columns (`emailVerified`, `createdAt`, …) —
Better Auth uses camelCase identifiers and `IMPORT FOREIGN SCHEMA` preserves
them.

### Removed from the legacy local users table

The pre-FDW `public.users` carried two Plexo-specific flags that no longer
exist:

* `email_verified` (Supabase timestamp) — use `"emailVerified"` (boolean)
* `is_super_admin` (boolean) — **derived from the env var `SUPER_ADMIN_EMAILS`**
  on every request. The env var is the source of truth; there is no DB column
  to mutate.

### Type of user id columns

All Plexo-local tables that reference a user now use `text`, not `uuid`:

* `workspaces.owner_id`
* `workspace_members.user_id` / `workspace_members.invited_by_user_id`
* `workspace_invites.invited_by_user_id` / `used_by_user_id`
* `workspace_key_shares.granted_by`
* `audit_log.user_id`
* `dashboard_cards.user_id`
* `session_logs.user_id`
* `user_app_authorizations.user_id`

## Foreign keys: what you can't have

**`postgres_fdw` foreign tables cannot be the target of FK constraints.**
This is a hard Postgres limitation (see the postgres_fdw docs). Before the
migration, Plexo had 15 FK constraints pointing at `users(id)`. All of them
were dropped. Referential integrity for user references is now enforced at
the **application level**:

* Workspace creation inserts a `workspace_members` owner row in the same
  transaction.
* Cascade deletes (e.g. `dashboard_cards.user_id → users.id ON DELETE CASCADE`)
  no longer fire — application code must handle orphan cleanup when the
  auth service deletes a user.
* Better Auth never physically deletes user rows (it uses a `banned` flag),
  so cascade delete was never actually exercised.

If you ever need DB-level referential integrity on user references, the only
real option is to materialize a local mirror table and sync on an interval
(or via a trigger/webhook). That's the fallback if FDW ever breaks.

## Cross-DB query performance

The membership check Plexo does on every workspace-scoped request is:

```sql
SELECT 1
  FROM workspace_members
 WHERE workspace_id = $1 AND user_id = $2
```

This query **never crosses the FDW** — `workspace_members` is fully local.
The FDW only kicks in when we join to `users` to hydrate `name`/`email`
(e.g. the members list endpoint). Those joins are indexed on both sides and
return in sub-millisecond time.

There is no cross-DB query on the hot path.

## Self-hosters

If you're running Plexo standalone (no pushd DB), you have two options:

1. **Run Better Auth on your own Postgres instance and point the FDW at it.**
   See `scripts/setup-fdw.sql` — set `fdw_host` / `fdw_dbname` to wherever
   your auth DB lives. This is the recommended path because it preserves the
   upgrade story if you ever add more Joeybuilt apps.

2. **Keep the legacy local users table.** Rename `public.users` back to a
   regular table and write your own signup flow. The pre-FDW code is tagged
   `v0.7.x` in git. No long-term support.

The repository ships with the FDW-mode schema and assumes (1). The Drizzle
definition of `users` is a `pgTable` even though the underlying object is a
foreign table — Drizzle's type layer doesn't distinguish, and that's fine
because the query plans are identical.

## Operator runbook

### Initial setup

```bash
ssh <vps>
docker cp scripts/setup-fdw.sql plexo-postgres:/tmp/
docker exec plexo-postgres psql -U postgres -d plexo \
    -v fdw_host=postgres \
    -v fdw_port=5432 \
    -v fdw_dbname=pushd \
    -v fdw_user=postgres \
    -v fdw_password="$AUTH_DB_PASSWORD" \
    -f /tmp/setup-fdw.sql
```

### Rotating the auth DB password

```sql
DROP USER MAPPING FOR postgres SERVER pushd_auth_server;
CREATE USER MAPPING FOR postgres
    SERVER pushd_auth_server
    OPTIONS (user 'postgres', password '<new_password>');
```

### Sanity check after any Postgres upgrade

```sql
SELECT COUNT(*) FROM public.users;
SELECT w.name, u.email
  FROM workspaces w
  JOIN users u ON u.id = w.owner_id;
```

If either query errors with `cannot connect to foreign server`, the FDW
user mapping or server definition was lost — re-run `setup-fdw.sql`.
