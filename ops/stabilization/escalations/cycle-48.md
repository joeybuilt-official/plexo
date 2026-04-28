# Cycle 48 Escalation — 2026-04-24

## Verdict
**Not a Plexo code bug.** Infrastructure / configuration issue in the execution
loop (which lives in `plexo-internal`, outside this repo). No code change in
`/opt/service/plexo` can fix this without re-introducing the internal
stabilization tooling that was deliberately excluded from the public release.

## Reported failure
From `ops/stabilization/results/cycle-0048.json`:

```
"scenarios": { "passed": 0, "failed": 1, "errors": [] }
```

The dispatched fixer prompt contained `Scenario failures: ` (empty) — no error
detail was captured.

Other signals from the same cycle were all clean:

| Signal         | Result |
|----------------|--------|
| Test suite     | GREEN (`pnpm test` — 8/8 tasks) |
| Security probes| PASS (0 findings)              |
| SCL eval       | Not run (no workspace configured) |

## Root cause
1. Plexo went public as v0.8.0 on 2026-04-24 (commit `a11b2f9b` — "Initial
   public release — starting from a clean tree with no prior history").
2. The public repo intentionally **does not** include the internal
   stabilization harness. `ops/stabilization/fleet/` does not exist here.
3. The execution loop at
   `/opt/service/plexo-internal/ops/stabilization/fleet/execution-loop.ts`
   still runs with `PLEXO_CODE_DIR=/opt/service/plexo` and invokes:

   ```
   tsx ops/stabilization/fleet/scenario-runner.ts --all
   ```

   from `cwd = /opt/service/plexo`.
4. That file does not exist in this repo, so tsx exits with
   `ERR_MODULE_NOT_FOUND`. Reproduced directly:

   ```
   $ tsx ops/stabilization/fleet/scenario-runner.ts --all
   Error [ERR_MODULE_NOT_FOUND]: Cannot find module
     '/opt/service/plexo/ops/stabilization/fleet/scenario-runner.ts'
   ```
5. `runScenarios()` in `execution-loop.ts` parses failures out of the child's
   stdout/stderr by matching lines containing `FAIL` or `ERROR`. The
   `ERR_MODULE_NOT_FOUND` line does not match either token, and the summary
   regex `/(\d+) failed/` doesn't hit either, so the fallback fires:

   ```ts
   failed: failMatch ? parseInt(failMatch[1]!) : (ok ? 0 : 1),
   errors, // [] — no FAIL/ERROR lines matched
   ```

   That produces the observed `failed: 1, errors: []`.

Earlier cycles (1–47, 2026-04-22 → 2026-04-23) recorded real scenario results
because the harness existed in `plexo` on the pre-release branch that was
later wiped by the clean public release.

## Why this is a one-way-door for me
- My working directory is restricted to `/opt/service/plexo`.
- The code that needs to change is in `/opt/service/plexo-internal`
  (the execution loop's scenario-runner path resolution and/or
  `PLEXO_CODE_DIR`).
- Copying `scenario-runner.ts`, `synthetic-workload.ts`, etc. from
  `plexo-internal` into the public `plexo` tree would re-introduce internal
  ops tooling that the v0.8.0 release deliberately excluded — that is a
  public-surface policy change, not a stabilization fix.
- No Plexo shipping code is broken. `pnpm typecheck && pnpm test` are green,
  security probes pass, regression report `regression-2026-04-24.md` is
  CLEAN.

## Recommended fix (owned by plexo-internal, not this repo)
In `plexo-internal/ops/stabilization/fleet/execution-loop.ts`, decouple the
harness's own directory from `PLEXO_CODE_DIR`:

- Use `__dirname`/`resolve(__dirname, '..')` (i.e., `plexo-internal`) as the
  `cwd` when spawning `scenario-runner.ts`, `synthetic-workload.ts`, and
  `scl-evaluator.ts`.
- Continue to use `PLEXO_CODE_DIR = /opt/service/plexo` only for
  running `pnpm test` / `pnpm typecheck` against the product source tree.
- Secondary: in `runScenarios`, also treat `ERR_MODULE_NOT_FOUND` /
  `Cannot find module` as a surfaced error string so future infra breaks are
  not reported as empty-error phantom scenario failures.

## Action taken this cycle
None in the `plexo` tree. No commits pushed.

