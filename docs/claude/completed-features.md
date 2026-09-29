# Completed Features

The shipped log. One entry per feature, newest first. Read this before proposing work — it is the
cheapest way to avoid rebuilding something that already exists.

Add an entry when a feature is tested and signed off, at the same time you move its folder into
`<area>/completed/`.

## Entry format

```markdown
### <Feature name> — YYYY-MM-DD
- **What shipped:** one or two sentences, in terms of what a user or caller can now do.
- **Area:** `<area>`
- **Archived plan:** `<area>/completed/<feature>/<renamed-file>.md`
- **Notable decisions:** anything that constrains future work; link the ADR in `architecture.md`.
- **Known gaps:** what was deliberately left out, so the next person does not read it as a bug.
```

---

### Self-host install boots end to end — 2026-09-27
- **What shipped:** `scripts/install.sh` now writes `AUTH_DATABASE_URL` (derived from the generated
  `POSTGRES_PASSWORD`, pointed at the compose-internal host), and `docker-compose.yml` defaults it on
  the `api` and `web` services. The documented install command now includes
  `--profile selfhosted --profile object-storage`, and the `migrate` service sets
  `APPLY_ORPHANED_SQL=1` so un-journaled hand-written SQL files apply on a fresh Docker install.
- **Area:** `infrastructure`
- **Notable decisions:** derive the DSN in the installer rather than requiring a second operator
  secret; keep Better Auth in its own schema of the shared database.
- **Known gaps:** none recorded.

### Doc-reference gate and agent-doc reconciliation — 2026-09-27
- **What shipped:** `scripts/check-doc-refs.sh` mechanically falsifies path claims made by
  agent-facing docs (`AGENTS.md`, `CLAUDE.md`, `README.md`, `.claude/rules/*.md`), and
  `scripts/sync-agents.sh --check` now gates provider-mirror drift in CI.
- **Area:** `governance`
- **Notable decisions:** the rule is deliberately loose — a reference passes if it resolves from the
  repo root, relative to the citing document, or by basename anywhere tracked — so shorthand still
  works while a name that exists nowhere fails.
- **Known gaps:** the gate is wired into `ci.yml` only; `pr-gate.yml` runs a portable subset.

### Public README rewrite + repository honesty pass — 2026-09-27
- **What shipped:** the public `README.md` now describes the repository as it actually ships,
  including a Known-gaps section and the real CI topology.
- **Area:** `governance`
- **Known gaps:** documented deliberately — no knowledge graph integration, no sprint orchestrator,
  11 of 24 registry connections are stubs, and `openapi.yaml` covers 11 of 77 mounted route modules.
