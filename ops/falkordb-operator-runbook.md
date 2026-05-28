# FalkorDB platform — operator runbook

Outstanding operator-side actions across the FalkorDB arc. These are
time-gated or env-side and cannot be automated from the codebase. The
list is the canonical source — `next-session.txt` is a thin pointer
to it, not a duplicate copy.

> **2026-05-28 the server migration.** All three OVH VPSes were decommissioned.
> Deploy target is now **the server** (`ssh <server>`). Compose at
> `/srv/plexo/`. All `ssh root@REDACTED_VPS_IP`
> references below are stale; substitute `ssh <server>`. All `docker compose`
> invocations from the server must specify both compose files:
> `docker compose -f docker-compose.yml -f docker-compose.prod.yml`.

## Deploy / health verification

- **Trigger auto-deploy daemon rebuild of graphiti-sidecar.** Required
  for new endpoints + schema changes shipped this evening:
  - `f3b588ec` — /v1/graph/{write,cypher} endpoints
  - `e58e180e` — A3 S1 cypher SET path (plexo_memory_id lift)
  - `37e6a746` — Fonto + Fylo + Pushd schemas
  - `7f76be9d` — C1 plexo-permissions graph schema
  - `06a757c9` — helm.yaml tenancy fix to `helm:<env>` + FF removal
  
  Verify via `/v1/health` — backend should be `falkordb`; the new
  schemas should load on boot (sidecar logs the registered apps).

## Time-gated clocks

- **A3 S1 cardinality clean clock.** Resets the day `e58e180e` lands
  in prod. After +7d, gate clears for A3 S2 (dual-pipeline wire-up).
- **C1 reconciliation 30-day clock.** Starts after these three are
  done in order (per ADR 0022):
  1. Deploy `7f76be9d` (shadow-write code).
  2. Run `scripts/seed-permission-graph.ts` once to backfill existing
     workspace_members.
  3. Run `scripts/reconcile-permission-graph.ts` once manually;
     should report `{clean:true}` on first run.
  4. Install the cron:
     ```
     0 6 * * * tsx /srv/plexo/source/plexo/scripts/reconcile-permission-graph.ts \
       >> /srv/plexo/data/permission-reconcile.log 2>&1
     # Note: this cron is already installed on the server as /etc/cron.d/permission-reconcile
     ```
  After 30 consecutive zero-diff days, read-path cutover is unblocked
  (separate cutover ADR per ADR 0022 §line 50).
- **B1 cutover (FALKORDB_PLANNER_WAVES=true).** After ≥7d clean Task
  dual-write logs.
- **B2 cutover (FALKORDB_CONVERSATIONS=true).** After ≥7d clean
  parity-test runs; add same-timestamp tiebreaker first (ADR 0021
  Failure-B).
- **Fonto-G cutover.** After agreement-audit window: ≥99% agreement
  on `[fonto-graph] phash NN disagreement` warn-rate; then replace
  `findPHashNearDuplicate` body with the graph query.

## One-shot operator scripts

- **Fonto-G vector-index bootstrap (per workspace, once).**
  ```
  CALL db.idx.vector.createNodeIndex('Asset', 'phash_vec', 64, 'L2', 16)
  ```
- **`pip install asyncpg`** in the graphiti-sidecar venv before
  running `backfill_conversations.py`.
- **`/etc/default/falkordb-backup` AWS env vars** (optional — only if
  you want the weekly Sunday S3 off-host upload):
  ```
  AWS_S3_BACKUP_BUCKET=<bucket>
  AWS_ACCESS_KEY_ID=<...>
  AWS_SECRET_ACCESS_KEY=<...>
  AWS_DEFAULT_REGION=us-east-1
  ```
  The cron file itself (`/etc/cron.d/falkordb-backup`) is now installed
  + path-templated automatically by `.github/workflows/deploy.yml` on
  every deploy; freshness no longer depends on it (in-process RDB tiers
  in `docker-compose.yml` are the primary safety net per ADR 0030
  Addendum 2026-05-15).

## T18 live smoke

Preserved here so the smoke script stops getting copy-pasted into
every handoff.

```sh
ssh <server>  # was: ssh root@REDACTED_VPS_IP (VPS decommissioned 2026-05-28)
# if sidecar needs rebuild:
cd /srv/plexo && docker compose \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d --no-deps --build graphiti-sidecar

# HMAC smoke:
WS="<personal_workspace_uuid>"
KEY="$PLEXO_SERVICE_KEY"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
BODY='{"workspace_id":"'$WS'","nodes":[{"label":"Task","id":"smoke-1","properties":{"description":"smoke","status":"queued"}}],"edges":[]}'
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$KEY" | awk '{print $2}')"
curl -s -X POST http://localhost:8000/v1/graph/write \
  -H "Content-Type: application/json" \
  -H "X-Plexo-Signature: $SIG" -H "X-Plexo-Timestamp: $TS" -d "$BODY"
# expect: {"nodes_written":1,"edges_written":0,"latencies":{...}}

QBODY='{"workspace_id":"'$WS'","cypher":"MATCH (t:Task {id: $id}) RETURN t.description AS desc, t.status AS status","params":{"id":"smoke-1"}}'
QSIG="sha256=$(echo -n "$QBODY" | openssl dgst -sha256 -hmac "$KEY" | awk '{print $2}')"
TS2=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
curl -s -X POST http://localhost:8000/v1/graph/cypher \
  -H "Content-Type: application/json" \
  -H "X-Plexo-Signature: $QSIG" -H "X-Plexo-Timestamp: $TS2" -d "$QBODY"
# expect: {"header":["desc","status"],"rows":[["smoke","queued"]]}

# cleanup:
DBODY='{"workspace_id":"'$WS'","cypher":"MATCH (t:Task {id: $id}) DELETE t","params":{"id":"smoke-1"}}'
# ...HMAC + curl /v1/graph/cypher
```
