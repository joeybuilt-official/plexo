# ops/

Operator-run scripts + cron entries + dashboard stubs that live alongside
the plexo repo but are deployed onto your prod host by hand (or by an
auto-deploy daemon when explicitly listed). Nothing in here is imported
by application code.

## FalkorDB backup + restore (Phase G, ADR 0030)

### Nightly snapshot

Script: `services/graphiti-sidecar/scripts/falkordb_backup.sh`
Cron:   `ops/falkordb-backup.cron`

Install on the prod host (paths assume `$PLEXO_REPO_DIR` is where this repo is cloned):

```bash
sudo cp "$PLEXO_REPO_DIR/ops/falkordb-backup.cron" /etc/cron.d/falkordb-backup
sudo chmod 644 /etc/cron.d/falkordb-backup
sudo mkdir -p /var/backups/falkordb
sudo touch /var/log/falkordb-backup.log
```

Default behavior: daily 03:30 UTC `BGSAVE` → `dump.rdb` copied to
`/var/backups/falkordb/falkordb-YYYY-MM-DD.rdb`. Retains the last 7 files;
older snapshots are removed by `find -mtime +7 -delete`.

### Weekly off-host upload

The cron also runs `--offhost-upload` Sunday 04:00 UTC. For that to actually
upload, the operator must set the AWS env vars in the cron environment
(either inline in `/etc/cron.d/falkordb-backup` or via
`/etc/default/falkordb-backup` sourced by the cron line):

```
AWS_S3_BACKUP_BUCKET=<your-bucket>
AWS_ACCESS_KEY_ID=<...>
AWS_SECRET_ACCESS_KEY=<...>
AWS_DEFAULT_REGION=us-east-1
```

If `AWS_S3_BACKUP_BUCKET` is unset the script logs a warning and exits 0 —
upload is best-effort, not blocking.

The repo deliberately does NOT contain S3 credentials. The cron file
references env vars by name only.

### Restore drill (non-destructive)

Script: `services/graphiti-sidecar/scripts/falkordb_restore.sh`

```bash
sudo "$PLEXO_REPO_DIR/services/graphiti-sidecar/scripts/falkordb_restore.sh" \
  /var/backups/falkordb/falkordb-2026-05-12.rdb
```

Spins up a fresh `plexo-falkordb-restore-drill` container on port 16379
with the supplied dump mounted as `/data/dump.rdb`, waits for redis to
finish loading, prints `GRAPH.LIST`, and tears the container down.

To verify a known set of workspaces is present:

```bash
EXPECTED_WORKSPACES_FILE=/etc/plexo/expected-workspaces.txt \
  "$PLEXO_REPO_DIR/services/graphiti-sidecar/scripts/falkordb_restore.sh" \
  /var/backups/falkordb/falkordb-2026-05-12.rdb
```

The script exits non-zero if any expected workspace UUID is missing from
the restored backup.

### Real restore (operator-run only — DESTRUCTIVE)

Not scripted; the steps are short and depend on operator judgement about
which backup is canonical.

1. Stop dependents that write to falkordb:
   ```bash
   ssh -i "$PLEXO_DEPLOY_SSH_KEY" "$PLEXO_DEPLOY_HOST" \
     "cd \$PLEXO_COMPOSE_DIR && docker compose stop graphiti-sidecar plexo-api"
   ```
2. Stop the live falkordb container:
   ```bash
   docker compose stop falkordb
   ```
3. Replace the volume contents (substitute `$PLEXO_FALKORDB_VOLUME` with your named volume from compose):
   ```bash
   docker run --rm \
     -v "$PLEXO_FALKORDB_VOLUME:/data" \
     -v /var/backups/falkordb:/backups:ro \
     alpine sh -c 'cp /backups/falkordb-YYYY-MM-DD.rdb /data/dump.rdb'
   ```
4. Bring everything back:
   ```bash
   docker compose up -d falkordb
   docker compose up -d graphiti-sidecar plexo-api
   ```
5. Verify: `redis-cli -h <host> -p 6379 GRAPH.LIST` lists expected workspaces.

## Other ops/ contents

- `coreaudit/` — pre-existing (Plexo core audit deliverables)
- `stabilization/` — pre-existing
- `helm-falkordb-dashboard.md` — Phase G/E stub for the future Helm dashboard widget
