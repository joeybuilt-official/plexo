# Cycle 59 Escalation — 2026-04-24

## Verdict
**Same root cause as cycles 48–58 — no Plexo code bug.** Twelfth
consecutive cycle reporting the same phantom failure. The execution
loop in `plexo-internal` keeps invoking
`ops/stabilization/fleet/scenario-runner.ts` with
`cwd = /opt/service/plexo`, where the harness does not exist.
See `escalations/cycle-48.md` for the original root-cause analysis and
the prescribed fix in `plexo-internal`.

## Reported failure
Dispatched fixer prompt contained `Scenario failures: ` (empty body) —
identical to cycles 48–58. No error detail, no stack, no scenario name.
`cycle-0059.json` confirms:

```json
"scenarios": { "passed": 0, "failed": 1, "errors": [] }
```

All other signals are clean:

| Signal          | Result |
|-----------------|--------|
| Test suite      | GREEN (8/8 tasks in 42.293s) |
| Security probes | PASS (0 findings) |
| SCL eval        | Not run (no workspace configured) |
| Workloads       | Not run |

## Reproduction (re-confirmed this cycle)
```
$ ls ops/stabilization/fleet/
ls: cannot access 'ops/stabilization/fleet/': No such file or directory
```

The harness still lives only in `plexo-internal`. The public `plexo`
tree deliberately excluded it at v0.8.0 (commit `a11b2f9b`).

## Why the fix is still not available in this repo
- `ops/stabilization/fleet/` does not exist in `/opt/service/plexo`
  (re-verified this cycle).
- The file that needs to change is in
  `/opt/service/plexo-internal/ops/stabilization/fleet/execution-loop.ts`
  — outside this session's allowed working directory.
- Copying the harness into the public repo would re-introduce internal
  ops tooling deliberately excluded from the v0.8.0 public release.
  That is a public-surface policy decision and a one-way door, not a
  stabilization fix (see rule 7: do not touch public API shape).

## Escalation persistence
Twelve consecutive cycles (48 → 59) reporting the same phantom failure.
Every subsequent cycle will keep firing the same empty-error
escalation until one of these happens in `plexo-internal`:
1. The execution loop's `cwd` is pointed at the internal tree, OR
2. The execution loop is paused, OR
3. `runScenarios()` is patched to treat `ERR_MODULE_NOT_FOUND` as a
   harness/config error rather than `failed: 1, errors: []`.

See `cycle-48.md` §"Recommended fix" for the prescribed change.

## Action taken this cycle
None in the `plexo` tree. No commits pushed. Escalation recorded.
