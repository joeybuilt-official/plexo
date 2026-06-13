# SDK / Plexo Core / DB schema compatibility matrix

This matrix is the authoritative reference for **which SDK version works
against which Plexo Core deployment**. Consumers should consult it before
bumping the SDK, and release engineers must add a row when cutting any
tagged SDK release.

The matrix tracks three coordinates:

- **SDK version** — the `@joeybuilt/plexo-sdk` npm version a consumer installs.
- **Plexo Core (min commit / version)** — the lowest Plexo server build that
  exposes every route the SDK calls. SDK methods that hit missing routes
  either return `null`/`[]` (best-effort methods like `addEpisode`,
  `searchFacts`) or throw (methods where errors must surface to the user,
  like `tools.gmessages.send`). See `packages/sdk/CHANGELOG.md` for the
  exact contract per method.
- **DB schema state** — the migration number (Drizzle journal entry) that
  must be applied on the Plexo Core's Postgres for the SDK's surface to work.
  Most SDK methods don't care about schema, but graph methods + tool bridges
  do — those rows are noted.

## Matrix

| SDK version | Plexo Core (min commit / version) | DB schema state                                      | Notes                                                                                          |
|-------------|-----------------------------------|------------------------------------------------------|------------------------------------------------------------------------------------------------|
| `1.3.0`     | commit `34470cdf` or later        | migrations `0001`–`0117` (latest: `0117_gmessages_phase2_schema`) | Adds `agents.runCustom`. Requires `PLEXO_RUN_JWT_SECRET` (≥32 chars) on Plexo API container. `runCustom` itself is schema-agnostic; the `0117` floor reflects the full set of migrations shipped on `34470cdf`. |
| `1.5.1`     | commit `fe11242` or later         | migrations `0001`–`0137` (latest: `0137_app_service_keys`) | First npm-published build of the `/connect` universal client (ADR 0001 §2): resolution-ladder discovery, `connect()` handshake + `contractVersion` negotiation, profile declaration, and `register()`/reconnect. Profile **negotiation** (`effectiveProfile`) needs the `workspace_app_grants` table (`0134`) + server-side enforcement; without it apps still connect but get an `unscoped`/`pending` status. 1.4.0 + 1.5.0 were never published (release-auth bug). |

## How to read a row

- Match your installed SDK version to the leftmost column.
- The Plexo Core column tells you the minimum server build. If your Plexo
  deployment is older, the new SDK methods will 404 (or behave per the
  best-effort fallback noted in `packages/sdk/CHANGELOG.md`).
- The DB schema state column tells you which migrations must be applied
  on the Plexo Core's Postgres. If you self-host Plexo and lag behind on
  migrations, expect server-side 500s.

## How to update this doc

Release engineers — when cutting any tagged SDK release (patch, minor, or
major), add a new row **above** the previous row (newest first). Fill all
four columns:

1. **SDK version** — the new `packages/sdk/package.json` version (the same
   value `release.yml` will tag).
2. **Plexo Core min commit / version** — the lowest Plexo Core SHA or
   tagged release that exposes every route this SDK version calls. If the
   SDK release adds no new server-side dependency, copy the previous row's
   value.
3. **DB schema state** — the Drizzle migration number that must be applied
   for any new methods to function server-side. If the SDK release adds no
   server-side surface, copy the previous row's value.
4. **Notes** — anything operators or consumers need to know: required
   env vars, breaking server-side contracts, gotchas around best-effort
   fallbacks, etc.

After updating, commit this doc as part of the **same PR** that bumps
`packages/sdk/package.json`. The release workflow does not auto-update
this matrix — humans curate it because the Plexo Core min-commit and DB
schema state are not derivable from the SDK source alone.
