# Key Patterns & Gotchas

Conventions to follow and traps to avoid, discovered the expensive way. Add to this file the moment
something surprises you — record the **symptom**, not just the fix, because the next person arrives
holding the symptom.

## Conventions

Patterns that new code must match. Keep each one checkable — a reviewer should be able to point at
a line and say "this violates it."

- Workspace isolation is a security invariant: authenticate and authorize workspace access before
  reading or writing workspace-owned data.
- One-way-door and irreversible actions stay human-gated; never bypass the policy or approval
  surfaces for convenience.
- Route model calls through the existing provider routing and fallback paths; never hardwire a vendor
  into feature logic.
- Schema changes start at `packages/db/src/schema.ts`, use generated Drizzle migrations, and apply
  through `pnpm db:migrate`. **Never** schema-push against live data.
- Interpolating a JS array into a `::type[]` cast renders a ROW constructor and fails at runtime.
  Pinned by `pnpm check:sql-arrays`.

## Gotchas

| Symptom you will see | Actual cause | What to do |
|---|---|---|
| A query returns wrong rows with no error | A `::type[]` cast received a JS array (ROW constructor) | Run `pnpm check:sql-arrays`; bind the elements, not the array |
| A rules edit silently stales the Cursor/Cline/Windsurf/Copilot mirrors | The doc mirror had no drift gate | Edit `AGENTS.md`, then `sh scripts/sync-agents.sh`; CI runs `--check` |
| Doc-gate fails citing a path you can see in the repo | The gate resolves paths from the repo root, the citing doc's dir, or by basename | Fix the citation or create the file it promises |
| A doc reference to a removed file blocks CI | Agent-facing docs are mechanically falsified by `scripts/check-doc-refs.sh` | Update the doc; do not allowlist it |

## Testing conventions

- What must have a test before it merges: business logic, validation, transformations, and every
  route/endpoint or public entry point.
- Tests live in `tests/` (unit, integration, e2e, load, chaos) plus colocated `*.test.ts` where the
  package convention places them.
- **Never skip, `.only`, or comment out a failing test to get a change through.** Fix it or report it.
- When you change query structure or call ordering, update the mocks in the same change — mocks
  consumed in sequence return the wrong data silently when the order shifts, and the test stays green.

## Things that look wrong but are intentional

Guard rails against well-meaning "cleanups" that reintroduce a fixed bug. One line each, with the
reason.

- `ci.yml` is push-only and runs on the self-hosted pool — **do not add a `pull_request` trigger**.
  This repo is public: a PR trigger lets a fork control the job body on a host that is
  uid=0 with the Docker socket mounted. PR gating lives in `pr-gate.yml` on hosted `ubuntu-latest`.
- `.dependency-cruiser-baseline.json` holds pre-existing violations on purpose — it is a ratchet.
