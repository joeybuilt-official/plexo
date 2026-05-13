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

### Read the FULL upstream release notes

The PR body truncates at 2000 chars. Read the complete notes at the URL in the PR.

### Decision matrix

| Probe | Notes mention Kuzu file-format change? | Notes mention API rename? | Action |
|---|---|---|---|
| PASS | no | no | **Merge.** Auto-deploy daemon ships. |
| PASS | yes | any | **Hold.** File-format change needs Phase 7-style restore plan before merge. Comment on PR + ping yourself. |
| PASS | no | yes | **Merge w/ caution.** Sidecar may need code adjustments — watch prod logs for 1h post-deploy. |
| FAIL | any | any | **Close.** Probe found a structural break. Comment on PR with the failure log. Don't merge. |

### Edge: probe FAIL but you believe it should pass

The probe runs against a real prod Kuzu snapshot, so a fail = real break. If you suspect the failure is in the probe wiring (not graphiti):
1. Manually re-run the workflow via Actions tab
2. If still fails, SSH to a CI runner-equivalent + run `./services/graphiti-sidecar/test/snapshot-probe.sh` locally with `set -x`
3. Report the issue upstream + close the PR

---

## After merging

The joeybuilt auto-deploy daemon polls `main` and rebuilds `service` on commit detection. Wait for the new image to be live, then:

```bash
ssh -i ~/.ssh/deploy-key root@REDACTED_VPS_IP \
  "docker exec service python -c 'import graphiti_core; print(graphiti_core.__version__)' 2>&1 || \
   docker exec service pip show graphiti-core | grep Version"
```

(Older graphiti-core builds don't expose `__version__`; the `pip show` fallback works.)

Run the cutover smoke against a tracked workspace to verify:

```bash
ssh -i ~/.ssh/deploy-key root@REDACTED_VPS_IP \
  "cd /srv/plexo && ./scripts/cutover-smoke.sh"
```

Expected: addEpisode → episode_id, search → ≥1 result. Same canonical 5-S-V-O probe text used by the workflow.

---

## Roll back

If the new version breaks prod (e.g., latency regression, data corruption):

```bash
ssh -i ~/.ssh/deploy-key root@REDACTED_VPS_IP '
  PREV=$(cat /srv/state/graphiti-sidecar.last_sha)
  docker tag service:$PREV service:latest
  cd /srv/platform/infra
  docker compose --profile graphiti up -d --no-deps graphiti-sidecar
'
```

The auto-deploy daemon writes `last_sha` before each rebuild; rollback retags the previous image as `latest` + restarts the container. Image retention policy: last N=5 (~30-day window).

If the breaking version's writes corrupted the Kuzu file format, image rollback isn't enough — restore from the most recent `corpus_migration_log` checkpoint:

```bash
# (operator-driven; see scripts/migrate-corpus-to-graphiti.ts --resume)
```

This is rare. Roll-forward is the default; rollback w/ corpus replay is only for confirmed file-format breaks.

---

## When to close instead of merge

- Probe FAIL: close + open issue upstream (link the probe failure log).
- Notes mention "BREAKING" + you don't have time to plan: close, revisit when ready.
- Patch version w/ a known regression mentioned in upstream issues: close, wait for the next patch.
- The watcher's PR is the 3rd attempt this week + each fails: close + temporarily disable the workflow's cron schedule until upstream stabilises. Re-enable when their next stable lands.
