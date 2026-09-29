# docs/claude — project knowledge base

Committed, team-shared context for both humans and coding agents. Everything here is written to be
read under context pressure: short, dated, and specific. Personal preferences and machine-local
setup do **not** belong here.

## Read order

Start at the top; read what bears on the task, not everything every time.

1. `roadmap.md` — the overall plan: initiatives in Now/Next/Later. Read with `in-progress.md`.
2. `in-progress.md` — the ordered queue of what is next, with plan-doc pointers. **Always read first among the tactical docs.**
3. `architecture.md` — decisions and their reasoning (ADR entries).
4. `key-patterns.md` — conventions, gotchas, testing practice.
5. `infrastructure.md` — deploy, hosting, data stores, secrets, background jobs.
6. `completed-features.md` — what already exists, so you do not rebuild it.
7. The `CHANGELOG.md` `[Unreleased]` section — the running per-change history. There is no
   `worklog.md` in this repo; the changelog is the worklog.
8. The relevant **area folder** — active plans and research for the thing you are changing.

## Layout

```
docs/claude/
  README.md               this file
  roadmap.md              canonical overall plan (initiatives, Now/Next/Later)
  in-progress.md          ordered queue of active work, rolls up into roadmap.md
  completed-features.md   shipped log, with archive paths
  architecture.md         decisions worth recording (ADRs) — the sole ADR home today
  infrastructure.md       how it runs and deploys
  key-patterns.md         patterns, gotchas, testing conventions
  _templates/
    plan.md               copy this to start any plan
    feature-area/         the per-area folder convention
  <area>/                 e.g. api/, ui/, data/, integrations/
    <feature>/plan.md     active work
    completed/            archived, renamed on ship
```

`roadmap.md` is the single plan doc for the whole project — one per repo, the file every agent reads
before planning and edits when planning. Everything else here is subordinate: `in-progress.md` is its
queue, `<area>/<feature>/plan.md` is its detail. A plan doc found anywhere else (repo root, a stray
folder) is stale by definition — fold it into a roadmap row and archive it.

Never create flat files at the top of `docs/claude/` — new work goes in an area folder.
