# In Progress

**Read this first.** The ordered queue of what is next. Top of the list is what to pick up now.
Every item points at a plan doc — if an item has no plan doc, it is not ready to start.

The **Notes** cell of the active row is its handoff: keep the *exact next step* there — the file to
open, the command to run, the blocker — refreshed whenever you pause, so the next session resumes
cold. A row with no next step is a row nobody can pick up.

Each row rolls up to a `roadmap.md` initiative and leaves a trail in `CHANGELOG.md` `[Unreleased]`.
When an item ships: remove its row from here, move its folder into `<area>/completed/`, and add an
entry to `completed-features.md`.

## Active queue

| # | Item | Area | Initiative | Plan doc | Status | Notes |
|---|------|------|------------|----------|--------|-------|
| 1 | Promote the portable `lint` checks onto the PR gate | governance | Repo governance and doc gates | — | Not started | `pr-gate.yml` runs a subset of `ci.yml`'s checks. The blocker that kept `lint` out (35 dead doc refs on `main`) is fixed; the remaining question is whether `check:sql-arrays`, `sync-agents.sh --check`, and `check-doc-refs.sh` should also run on fork PRs. Next step: decide, then add the three `run:` lines to `pr-gate.yml` and drop the explanatory comment. |

**Status vocabulary:** `Not started` · `In progress — milestone N of M` · `Blocked — <on what>` ·
`In review` · `Done — archiving`.

## Blocked / waiting

Items that cannot move, and the one thing each is waiting on. Review this list before starting
anything new — an unblocked item here outranks a fresh one.

| Item | Blocked on | Since |
|------|-----------|-------|
| | | |

## Parked

Ideas deliberately deferred. Keep the reason — "we said no because X" is what stops the same
proposal coming back every month.

| Item | Why parked | Revisit when |
|------|-----------|--------------|
| | | |
