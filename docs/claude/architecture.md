# Architecture Decisions

Decisions worth recording, with the reasoning — so the next person extends the design instead of
re-litigating it. ADRs are numbered `ADR-NNNN` and never deleted; a superseded decision gets a new
entry that names the one it replaces.

This file is the sole ADR home today. There is no separate `adr/` directory yet; if decisions ever
outgrow this file, a tree can be created and indexed from here.

## Index

| ADR | Decision | Status | Date |
|-----|----------|--------|------|
| ADR-0001 | Clean Architecture layering, enforced by `pnpm arch:check` | Accepted | — |

## ADR-0001 — Clean Architecture layering

- **Context.** Business rules were reachable from route handlers and UI components, so framework and
  vendor choices leaked into logic that should not know about them.
- **Decision.** Dependencies point inward only: Entities/Domain ← Use Cases/Application ← Interface
  Adapters ← Frameworks & Drivers. Boundaries are mechanically enforced by `pnpm arch:check`
  (`tsconfig.arch.json` + `dependency-cruiser`), whose baseline (`--ignore-known`) is a **ratchet**,
  not an allowlist: new violations fail, and the baseline is burned down cluster by cluster.
- **Consequence.** A vendor swap must stay inside Interface Adapters + Frameworks & Drivers. If a
  domain or use-case file would appear in that diff, the design is not done.
- **Never** regenerate the baseline to make a build pass.
