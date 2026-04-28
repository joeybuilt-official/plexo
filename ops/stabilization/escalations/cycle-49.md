# Cycle 49 Escalation — 2026-04-24

## Verdict
**Same root cause as cycle 48 — no Plexo code bug.** This is a repeat of the
infrastructure issue documented in `escalations/cycle-48.md`. The fix lives in
`/opt/service/plexo-internal`, outside this repo's working directory.

## Reported failure
From `ops/stabilization/results/cycle-0049.json`:

```
"scenarios": { "passed": 0, "failed": 1, "errors": [] }
"sloBreaches": ["1 scenario failures"]
```

Dispatched fixer prompt contained `Scenario failures: ` (empty body) — no
error detail, identical to cycle 48.

Other signals were clean:

| Signal          | Result |
|-----------------|--------|
| Test suite      | GREEN (8/8 tasks, 43.83s) |
| Security probes | PASS (0 findings) |
| SCL eval        | Not run (no workspace configured) |

## Why the fix is still not available in this repo
- `ops/stabilization/fleet/` does not exist in `/opt/service/plexo`
  (verified again this cycle: `ls ops/stabilization/fleet/` → not found).
- The harness at
  `/opt/service/plexo-internal/ops/stabilization/fleet/execution-loop.ts`
  still invokes `scenario-runner.ts` with `cwd = /opt/service/plexo`,
  so `tsx` exits with `ERR_MODULE_NOT_FOUND`, which is then miscounted as
  `failed: 1, errors: []` by `runScenarios()`.
- The prescribed fix (see cycle-48.md §"Recommended fix") is to change
  `plexo-internal/.../execution-loop.ts` to anchor the harness's own `cwd`
  to `__dirname` instead of `PLEXO_CODE_DIR`. That file is outside my
  allowed working directory.
- Copying the harness into this public repo would re-introduce the internal
  ops tooling deliberately excluded from the v0.8.0 public release
  (`a11b2f9b` on 2026-04-24). That is a public-surface policy decision, not
  a stabilization fix, so it is out of scope for this cycle.

## Escalation persistence
Because the upstream fix has not landed, every subsequent cycle will
continue to report `failed: 1, errors: []` with no actionable payload. The
execution loop should be paused or pointed at the internal tree until the
`plexo-internal` change ships, otherwise these phantom escalations will
keep firing.

## Action taken this cycle
None in the `plexo` tree. No commits pushed. See `cycle-48.md` for the full
root-cause write-up and the prescribed fix in `plexo-internal`.
