# Runbook — graphiti-core upstream bump

**When this fires:** the `graphiti-core upstream watcher` GH Actions workflow opened a PR titled `chore(graphiti-core): bump to X.Y.Z`.

**Your job:** review + merge OR close. Never auto-merge.

---

## Decide: merge or close?

### Read the PR body

The PR body shows:
- Previous + new graphiti-core version
- Schema-compat probe result (PASS / FAIL)
- Truncated upstream release notes

The probe (`services/graphiti-sidecar/test/probe.sh`) builds the image at the
candidate pin, stands it up against a throwaway FalkorDB with a stub inference
backend, and drives ingest → graph read → search. It asserts **structure**, not
extraction quality: the stub answers every model call with schema-shaped
constants, so a bump that degrades what the LLM extracts still passes. Quality
regressions are caught by prod observation.

### Read the FULL upstream release notes

The PR body truncates at 2000 chars. Read the complete notes at the URL in the PR.

### Decision matrix

| Probe | Notes mention a FalkorDB storage/index change? | Notes mention API rename? | Action |
|---|---|---|---|
| PASS | no | no | **Merge.** Auto-deploy daemon ships. |
| PASS | yes | any | **Hold.** A storage/index change needs a restore plan before merge (FalkorDB vector indexes are built at a fixed dimension). Comment on PR + ping yourself. |
| PASS | no | yes | **Merge w/ caution.** Sidecar may need code adjustments — watch prod logs for 1h post-deploy. |
| FAIL | any | any | **Close.** Probe found a structural break. Comment on PR with the failure log. Don't merge. |

### Edge: probe FAIL but you believe it should pass

The probe runs the real image against a real FalkorDB, so a fail is a real break — but it is a break in EITHER graphiti-core or a transitive dependency, since the sidecar's direct pins do not bound their own dependencies. Check which before blaming the bump:
1. Manually re-run the workflow via the Actions tab (the `cancelled` flake is known).
2. If it still fails, reproduce on any Docker host: `docker build -f services/graphiti-sidecar/Dockerfile -t sidecar:probe . && PROBE_IMAGE=sidecar:probe bash services/graphiti-sidecar/test/probe.sh`. The probe prints the failing step and dumps the sidecar + stub logs.
3. If the same probe fails on the CURRENT pin too, the bump is innocent — a transitive release broke the build. Pin it in `requirements.txt` alongside `openai` and `redis` (which are pinned for exactly this reason) rather than closing the PR.

---

## After merging

Your auto-deploy daemon (or equivalent) polls `main` and rebuilds the graphiti sidecar on commit detection. Wait for the new image to be live, then verify the running version (env: `PLEXO_DEPLOY_HOST`, `PLEXO_DEPLOY_SSH_KEY`, `PLEXO_GRAPHITI_CONTAINER` — default `plexo-graphiti-sidecar`):

```bash
ssh -i "$PLEXO_DEPLOY_SSH_KEY" "$PLEXO_DEPLOY_HOST" \
  "docker exec $PLEXO_GRAPHITI_CONTAINER python -c 'import graphiti_core; print(graphiti_core.__version__)' 2>&1 || \
   docker exec $PLEXO_GRAPHITI_CONTAINER pip show graphiti-core | grep Version"
```

(Older graphiti-core builds don't expose `__version__`; the `pip show` fallback works.)

Run the cutover smoke against a tracked workspace to verify:

```bash
ssh -i "$PLEXO_DEPLOY_SSH_KEY" "$PLEXO_DEPLOY_HOST" \
  "cd \$PLEXO_OPS_DIR && ./scripts/cutover-smoke.sh"
```

Expected: addEpisode → episode_id, search → ≥1 result. Same canonical 5-S-V-O probe text used by the workflow.

---

## Roll back

If the new version breaks prod (e.g., latency regression, data corruption):

```bash
ssh -i "$PLEXO_DEPLOY_SSH_KEY" "$PLEXO_DEPLOY_HOST" '
  PREV=$(cat "$PLEXO_OPS_STATE_DIR/graphiti-sidecar.last_sha")
  docker tag "$PLEXO_GRAPHITI_CONTAINER:$PREV" "$PLEXO_GRAPHITI_CONTAINER:latest"
  cd "$PLEXO_COMPOSE_DIR"
  docker compose --profile graphiti up -d --no-deps graphiti-sidecar
'
```

The auto-deploy daemon writes `last_sha` before each rebuild; rollback retags the previous image as `latest` + restarts the container. Image retention policy: last N=5 (~30-day window).

If the breaking version's writes corrupted the FalkorDB graph, image rollback isn't enough — restore from a FalkorDB backup (`services/graphiti-sidecar/scripts/falkordb_restore.sh`) or replay from the most recent `corpus_migration_log` checkpoint:

```bash
# (operator-driven; see scripts/migrate-corpus-to-graphiti.ts --resume)
```

This is rare. Roll-forward is the default; rollback w/ corpus replay is only for confirmed storage-format breaks.

---

## When to close instead of merge

- Probe FAIL: close + open issue upstream (link the probe failure log).
- Notes mention "BREAKING" + you don't have time to plan: close, revisit when ready.
- Patch version w/ a known regression mentioned in upstream issues: close, wait for the next patch.
- The watcher's PR is the 3rd attempt this week + each fails: close + temporarily disable the workflow's cron schedule until upstream stabilises. Re-enable when their next stable lands.
