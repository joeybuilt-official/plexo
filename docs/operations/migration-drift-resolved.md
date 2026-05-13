# Migration Drift Resolution — 2026-04-10

## The drift

The VPS `drizzle.__drizzle_migrations` table had 53 rows tracked while the
repository contained 66 migration files (`0000` through `0066`, with gaps in
the local journal). Running `drizzle-kit migrate` against the VPS would have
replayed 14 already-applied migrations and failed on duplicate columns,
already-existing tables, and pre-populated registry rows.

Root causes:

1. **Journal gap**: `packages/db/drizzle/meta/_journal.json` was missing
   entries for `0051` through `0061`. The SQL files existed on disk but the
   journal jumped from idx 50 directly to idx 62. drizzle-kit was blind to
   the files in that range.
2. **Tracker gap**: The VPS migrations table stopped at the hash for
   `0063_add_failed_task_status` (row id 53). No rows existed for
   `0051`–`0061`, `0064`, `0065`, or `0066`, even though the effects of most
   of those migrations had been applied manually or via ad-hoc psql runs.
3. **Two partial migrations**: `0061` (`message_deliveries`) existed as a
   table but with a different schema than the migration file produced
   (pre-existing `text` `workspace_id`, no FK to `workspaces`, differently
   named indexes). `0065` (`code_health_schema_fixes`) had never been run:
   `models_knowledge` still had 70 duplicate ids and
   `memory_entries.embedding` was an untyped `vector` column rather than
   `vector(384)`.

## Inventory

| Migration | File                                   | Effect                              | VPS State before     | Action           |
|-----------|----------------------------------------|-------------------------------------|----------------------|------------------|
| 0051      | 0051_hub_schema.sql                    | extension_registry category/search  | applied              | mark applied     |
| 0052      | 0052_scl_golden_record.sql             | workspace_mindsets golden_record    | applied              | mark applied     |
| 0053      | 0053_scl_drift_warnings.sql            | new table scl_drift_warnings        | applied              | mark applied     |
| 0054      | 0054_inference_scl_metadata.sql        | inference_logs SCL cols             | applied              | mark applied     |
| 0055      | 0055_foundry_tables.sql                | 3 foundry_* tables                  | applied              | mark applied     |
| 0056      | 0056_add_conversation_rule_source.sql  | enum value conversation             | applied              | mark applied     |
| 0057      | 0057_embedding_variable_dimensions.sql | untype memory_entries.embedding     | applied              | mark applied     |
| 0058      | 0058_provider_instances.sql            | new table provider_instances        | applied              | mark applied     |
| 0059      | 0059_per_capability_ordering.sql       | chat/embedding_preference_order     | applied              | mark applied     |
| 0060      | 0060_ssh_connection_registry.sql       | ssh row in connections_registry     | applied              | mark applied     |
| 0061      | 0061_message_deliveries.sql            | message_deliveries table            | partial (see note)   | mark applied     |
| 0064      | 0064_session_topic_embedding.sql       | conversations.session_embedding     | applied              | mark applied     |
| 0065      | 0065_code_health_schema_fixes.sql      | dedupe models_knowledge, vector(384)| unapplied            | run + mark       |
| 0066      | 0066_rename_fabric_to_pex.sql          | extensions.pex_version, defaults    | applied              | mark applied     |

Note on 0061: the `message_deliveries` table pre-existed with a different
shape. The migration uses `CREATE TABLE IF NOT EXISTS` so running it is a
no-op. We chose not to recreate the table — the app already writes to and
reads from it, and recreating would destroy delivery history. Follow-up: a
future migration should reconcile the pre-existing columns (`workspace_id
text`, no FK) with the intended shape if strict consistency is needed.

## Actions taken

1. **Backup**: dumped the drizzle schema to
   a backup dump on the VPS before applying.
2. **Ran migration 0065** inside a single transaction on the VPS:
   - `DELETE FROM models_knowledge a USING models_knowledge b WHERE a.id = b.id AND a.ctid < b.ctid;` — removed 72 duplicate rows, 578 → 506.
   - `DROP INDEX IF EXISTS memory_entries_embedding_idx;`
   - `ALTER TABLE memory_entries ALTER COLUMN embedding TYPE vector(384) USING embedding::vector(384);` — all live vectors are 384-dim.
   - `CREATE INDEX memory_entries_embedding_idx ON memory_entries USING hnsw (embedding vector_cosine_ops);`
3. **Inserted 14 tracker rows** into `drizzle.__drizzle_migrations` with
   hashes computed as `sha256sum` of each SQL file and `created_at` values
   matching synthesized `when` timestamps in `_journal.json` (1775606408000
   through 1775606418000 for 0051–0061, plus the original 0064/0065/0066
   values).
4. **Fixed `_journal.json`** to add missing entries 0051 through 0061, using
   the same synthesized `when` values so the journal and tracker agree.

## Final state

```
SELECT count(*) FROM drizzle.__drizzle_migrations;  -- 67
SELECT count(*), count(DISTINCT id) FROM models_knowledge;  -- 506 | 506
SELECT format_type(atttypid, atttypmod) FROM pg_attribute
  WHERE attrelid='memory_entries'::regclass AND attname='embedding';
  -- vector(384)
SELECT column_name FROM information_schema.columns
  WHERE table_name='extensions' AND column_name LIKE '%pex%';
  -- pex_version
```

Tracker and journal are now in sync. A fresh `drizzle-kit migrate` run would
be a no-op.

## Prevention

1. **Add migrate to the deploy pipeline**. The Command Engine deploy webhook
   should run migrations before swapping the API container. This is the
   single largest gap — migrations have been applied manually via psql for
   weeks.
2. **Never hand-edit the journal**. Missing entries for 0051–0061 strongly
   suggest someone created the SQL files without running `drizzle-kit
   generate`. Require a clean `drizzle-kit generate` step in CI — fail the
   build if SQL files exist without matching journal entries.
3. **Hash verification in CI**. Add a check script that compares
   `sha256sum` of each SQL file to the `hash` field in the journal (drizzle
   stores this format starting from some versions). Fails fast on drift.
4. **Pre-deploy gate**: before every deploy, run a read-only diff between
   the local journal and the remote `__drizzle_migrations` table. Abort the
   deploy if any row from the journal is missing from the tracker or vice
   versa.
