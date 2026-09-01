# Disaster Recovery Runbook

Covers Plexo's self-host Docker Compose stack. Also applies to the
managed Joeybuilt deployment — the scripts are identical; only the
off-server destination differs.

## What gets backed up

The `postgres-backup` sidecar in `docker-compose.yml` runs
`scripts/backup.sh` on a fixed interval (default: every 24 h). Each
run produces a gzipped SQL dump of the `plexo` Postgres database:

```
plexo-20260410T071500Z.sql.gz
```

Files land on the `postgres-backups` named Docker volume, which maps
to `/var/lib/docker/volumes/<project>_postgres-backups/_data` on the
host. The project prefix is the compose project name, so the path is
`/var/lib/docker/volumes/<project>_postgres-backups/_data`.

Retention is governed by `BACKUP_RETENTION_DAYS` (default 7). Files
older than the retention window are pruned by `backup.sh` at the end
of every successful run.

### WAL archiving (point-in-time recovery)

WAL archiving is enabled via `docker/postgres/postgresql.conf`. Completed
WAL segments are copied to `/backups/wal/` on the same `postgres-backups`
volume. Combined with a base backup, this enables point-in-time recovery
(PITR) to any moment between daily dumps.

To perform PITR, restore the most recent base backup (daily dump), then
replay WAL files up to the target timestamp using `pg_wal_replay`.

### MinIO asset backup

If the MinIO Client (`mc`) is available in the backup sidecar,
`backup.sh` mirrors the asset bucket to `/backups/minio/` after each
pg_dump run. Operators using external S3 should configure their own
backup strategy (cross-region replication, bucket versioning, etc).

### What is NOT backed up

- Redis / Valkey state (ephemeral queue + caches; rebuilt on boot)
- `generated_skills` volume (agent-written tool source; re-derivable)
- `caddy_data` / `caddy_config` (TLS certs re-issue automatically)

## How backups run

- **Schedule:** every `BACKUP_INTERVAL_SECONDS` (default 86 400 = 24 h)
- **Retention:** `BACKUP_RETENTION_DAYS` (default 7 daily archives)
- **Trigger:** sidecar long-running loop (no cron dep); survives host
  reboots because `restart: unless-stopped` is set on the service.
- **Failure mode:** pg_dump failure logs to stdout AND removes the
  partial file so the retention scan never treats a corrupted dump as
  a valid backup. The sidecar stays running and retries on the next
  interval.

## Verification

### Quick check — did the last backup run?

```bash
docker compose exec postgres-backup ls -lh /backups
```

Expect one file per day for up to `BACKUP_RETENTION_DAYS` days.
File sizes should be of the same order of magnitude as each other
(wild swings indicate dump corruption).

### Manual trigger

```bash
docker compose exec postgres-backup /backup.sh
```

Should print a line like:

```
[2026-04-10T07:15:00Z] backup: OK /backups/plexo-20260410T071500Z.sql.gz (842931 bytes)
```

### Integrity check (without overwriting prod)

```bash
# 1. Copy the archive out of the sidecar
docker compose cp postgres-backup:/backups/plexo-20260410T071500Z.sql.gz .

# 2. Gunzip and skim the head — should start with pg_dump header
gunzip -c plexo-20260410T071500Z.sql.gz | head -20

# 3. (Optional) Restore into a throw-away DB on the host to verify
docker exec -it <postgres-container> psql -U plexo -c 'CREATE DATABASE plexo_restore_test'
gunzip -c plexo-20260410T071500Z.sql.gz | docker exec -i <postgres-container> psql -U plexo -d plexo_restore_test
docker exec -it <postgres-container> psql -U plexo -d plexo_restore_test -c '\dt'
docker exec -it <postgres-container> psql -U plexo -c 'DROP DATABASE plexo_restore_test'
```

## Restore from backup

**Downtime:** expect 2–10 minutes for a database of ≤1 GB. Longer for
bigger datasets. All user traffic is blocked for the duration of the
drop/recreate step.

```bash
# 1. Stop the API + web so nothing is writing to the DB
docker compose stop api web migrate

# 2. Pick a backup (most recent or a known-good one)
docker compose exec postgres-backup ls -lh /backups
BACKUP=plexo-20260410T071500Z.sql.gz

# 3. Extract the archive onto the host (or into the postgres container)
docker compose cp postgres-backup:/backups/$BACKUP /tmp/$BACKUP
gunzip /tmp/$BACKUP  # → /tmp/plexo-...sql

# 4. Drop + recreate the DB
docker compose exec postgres psql -U plexo -d postgres -c 'DROP DATABASE plexo'
docker compose exec postgres psql -U plexo -d postgres -c 'CREATE DATABASE plexo OWNER plexo'

# 5. Restore
cat /tmp/plexo-20260410T071500Z.sql | docker compose exec -T postgres psql -U plexo -d plexo

# 6. Run migrations (in case the dump is from an older schema version)
docker compose up -d migrate
docker compose logs -f migrate   # wait for it to exit 0

# 7. Start the app back up
docker compose up -d api web

# 8. Smoke test
curl -fsS http://localhost:3001/health
```

If step 5 fails with permission errors, the dump was likely created
with a different `POSTGRES_USER`. Use `--no-owner --no-privileges` on
`pg_dump` — the sidecar does this by default.

## Rolling back a bad deploy

Unlike a data-loss scenario, a bad deploy is usually just a code
rollback:

```bash
cd /opt/plexo  # or your self-host clone path
git log --oneline -20
git checkout <known-good-sha>
docker compose build api web migrate
docker compose up -d api web
docker compose logs -f api
```

If the bad deploy also migrated the schema forward in a breaking way,
you'll need the full restore procedure above AFTER rolling the code
back. Always back up before running migrations in production.

## Off-server replication (recommended)

The sidecar writes to a Docker volume on the same host. If the host
dies, the backups die with it. For real disaster recovery, copy the
backup files off-server with a cron job that runs OUTSIDE the
sidecar — e.g. on the host:

```bash
# /etc/cron.d/plexo-backup-offsite
#
# Mirrors the latest backup to a remote store every hour.
0 * * * * root rclone copy \
    /var/lib/docker/volumes/joeybuilt_postgres-backups/_data/ \
    b2:my-plexo-backups/ \
    --include 'plexo-*.sql.gz' \
    --min-age 1m
```

Supported destinations via `rclone`: Backblaze B2, AWS S3, Cloudflare
R2, OVH Object Storage, Google Cloud Storage, Wasabi, local NAS (sftp,
smb), etc. Pick one based on cost and latency requirements.

For encryption at rest on the off-server copy, use `rclone crypt` or
`gpg --symmetric` before upload.

## Managed deployment (production)

The production host uses the same `postgres-backup` sidecar wired into
your `docker-compose.prod.yml`. Configure an off-server cron to mirror
backups to your preferred object storage provider (see the rclone
example above).

## Known issues — watch for on restore

Both restore-time issues surfaced by the 2026-04-10 DR drill were
closed in Phase 10 (migration `0065_code_health_schema_fixes.sql`):

1. **`models_knowledge` duplicates** — live DB had 291 rows with
   duplicate IDs that pre-dated the PK. Deduped, PK replays cleanly.
2. **`memory_entries.embedding` untyped vector** — HNSW index
   failed to replay on restore. Column now pinned to `vector(384)`
   (matches the `plexo-embed-v1` model), HNSW index rebuilt.

Any new DR drill should complete with zero errors. If a drill does
surface new replay errors, log them here with the fix.

## Checklist — quarterly DR drill

Run this every quarter and record the result in the engineering log:

- [ ] Backups from the last 7 days are present
- [ ] `backup.sh` manual run produces a valid gzip with > 100 bytes
- [ ] Last backup restores into a scratch DB without errors
- [ ] `docker compose exec postgres psql -U plexo -d plexo_restore_test -c 'SELECT count(*) FROM tasks'` returns a plausible number
- [ ] Off-server copy exists and is < 24 h old
