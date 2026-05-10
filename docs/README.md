# Plexo docs

Public documentation for the Plexo platform. This index is flat by
design — add a new file here, not a new subdirectory, unless the
content genuinely clusters.

## Getting oriented
- `getting-started.md` — first-run + dev setup
- `architecture.md` — system architecture overview
- `configuration.md` — env vars and runtime settings
- `faq.md` — common questions
- `concepts.md` — core vocabulary (workspace, task, memory, skill, SCL)

## Using Plexo
- `skills.md` — the Skill+ extension format
- `plugin-sdk.md` — extension author guide (public SDK)
- `memory.md` — memory + semantic retrieval
- `mcp.md` — Model Context Protocol integration
- `a2a.md` — agent-to-agent federation
- `intelligence-verification.md` — quality-judge ensemble + side-effect detection

## Running Plexo
- `self-host.md` — self-hosted operator guide
- `deploy.md` — managed / prod deploy details
- `operations/` — runbooks (DR, incidents)
- `security/` — security design
- `analytics/` — analytics architecture + privacy model
- `ANALYTICS.md` — user-facing analytics doc
- `NAMING.md` — naming conventions (services, tables, env vars)

## Development
- `pex/` — PEX extension SDK spec and reference
- `beta/` — beta feature specs
- `pax/` — pax format notes
- `help/` — in-product help content source
- `ssh-security-design.md`, `ssh-security-audit.md`,
  `ssh-e2e-readiness.md` — SSH capability hardening notes
- `cli-github-actions-example.yml` — sample GitHub Actions workflow

## Live planning + review
- `review/MASTER.md` — the active optimization review and phase
  completion log. This is the living document; start here if you want
  to know what's in flight.
- `review/next/` — per-phase specs for the current review

## History
- `archive/` — historical audits, decisions, overhaul / hardening /
  deploy-phase docs, agent self-management design notes, the
  pre-trim `AGENTS-historical.md`, etc. Read only when you need the
  "why" behind a current decision.

## Outside `docs/`
- `AGENTS.md` at the repo root — LLM-agent quick-reference (deploy,
  ship gate, conventions). Trimmed to stay under 15 KB.
- `README.md` at the repo root — project overview and self-host
  quick-start.
- `CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE` — standard OSS files.
