# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

## This is a PUBLIC repository

Everything committed here — code, comments, docs, **and git history** — is world-visible. Treat every change as a public disclosure.

### Never commit
- Secrets of any kind: API keys, tokens, passwords, signing keys, `.env` files (only `*.env.example` with placeholder values belong here).
- Infrastructure details: production server hostnames or IP addresses, deploy paths, internal container/service names, SSH targets, cron/runbook specifics tied to a real deployment.
- Personal information: real names, personal email addresses, chat IDs, or other operator/owner PII.
- Internal planning or audit scaffolding: session plans, checklists, `*-findings` docs, scratch notes. These are gitignored — keep them out of commits.

### Before every commit/push
- Use environment variables and placeholders (`<server>`, `<prod-server-ip>`, `${VAR}`) instead of real infrastructure values.
- If you add config or deployment docs, write them generically — assume a reader who is not the maintainer.
- When in doubt, scan the diff for the categories above (a secret scanner such as `gitleaks` is a good final gate).

### Conventions
- Monorepo managed with `pnpm` (see `packageManager` in `package.json`) + Turborepo.
- Dependencies: prefer in-range updates; pin security fixes for transitive packages via `pnpm.overrides` in the root `package.json`.
- Keep the build green: run typecheck/tests before pushing.

---

Canonical, provider-neutral instructions for ANY coding agent or LLM working in this repo
(Claude Code, OpenAI Codex, Cursor, Gemini, GitHub Copilot, Windsurf, Cline, aider, …).
If you are Claude Code, `CLAUDE.md` imports this file — read it as your hub.

The tool-native files (`.cursor/rules/`, `.clinerules/`, `.windsurf/rules/`,
`.github/copilot-instructions.md`, `GEMINI.md`, `CONVENTIONS.md`) are **generated** from the
`MIRROR` block below. Do not edit them; edit `AGENTS.md` and run `sh scripts/sync-agents.sh`.

## Start here — onboarding contract (read in this order, before writing anything)

This is the exact order a new agent reads, whatever tool you are. It maps 1:1 to the four things you
must do: **find the context**, **not break anything**, **carry existing work forward**, **make new
work fit**.

1. **This file (`AGENTS.md`)** — the map and the non-negotiables below.
2. **`docs/claude/roadmap.md`** — the overall plan: the initiatives this project is committed to, in
   Now / Next / Later. This is the strategic arc — what we are building and where we are in it.
3. **`docs/claude/in-progress.md`** — the tactical queue that rolls up into the roadmap: what is in
   flight, what is next, and the *exact next step* to resume cold. **Carry these initiatives forward;
   do NOT open a parallel track for work already queued here.**
4. **The running worklog** — `docs/claude/worklog.md`, or this repo's `CHANGELOG.md` / `HISTORY.md`
   `[Unreleased]` section if it keeps one instead. Skim what landed recently. You will append one line
   here in the same change as your work (see Non-negotiables).
5. **`CLAUDE.md`** — project overview, tech stack, the real command table, and the directory map.
   Plain markdown; read it even if you are not Claude. It lists the rule modules as `@.claude/rules/*.md`.
6. **`.claude/rules/clean-architecture.md`** — the architecture premise every change obeys (below).
7. **The `.claude/rules/` module governing what you are about to touch** — `testing.md`, `database.md`,
   `api-design.md`, `frontend.md`, `error-handling.md`, etc. Plain markdown; open the one that applies.
8. **`docs/claude/architecture.md`** and **`key-patterns.md`** — decisions and gotchas, so you extend
   the design instead of re-litigating it.

Then: **propose before you edit**, **keep the roadmap/plan/worklog current in the SAME change as the
work**, and **verify (test + typecheck + lint + the architecture-boundary check) before you commit.**
Full doctrine: `.claude/rules/workflow.md` and `.claude/rules/documentation.md`.

In a monorepo the closest `AGENTS.md` to the file you are editing wins; this root file is the default.

## Non-negotiables

- **Clean Architecture is the premise of all code here.** Dependencies point inward only; business
  rules never import a framework, ORM, HTTP client, or vendor SDK; every external concern sits behind
  a port with its adapter at the edge; one composition root wires them. Name the layers your change
  touches before you write it. Full rule + review checklist: `.claude/rules/clean-architecture.md`.
- **Plan before code; verify before commit.** No multi-file change without a persisted plan under
  `docs/claude/`; no commit without a green test / typecheck / lint run in the same session.
- **The plan and worklog are never stale.** Every change updates `docs/claude/in-progress.md` (its
  status + Next step), appends one line to the running worklog, and moves the `roadmap.md` initiative
  when it starts or ships — all in the same commit as the code. Shipped-but-unlogged counts as not
  done. Full doctrine: `.claude/rules/documentation.md`.

## Architecture is non-negotiable

This project is built on Clean Architecture. Every change — planned or written, by any human or AI
agent, in any tool — obeys one rule: **source-code dependencies point inward only.** Business rules
(Entities / Domain, Use Cases / Application) never import a framework, ORM, HTTP client, UI library,
vendor SDK, or environment/config. Every external concern sits behind a **port** (an interface
declared in the use-case layer) implemented by an **adapter** at the edge.

- You **MUST** place each new piece in one of the four layers and keep its imports pointing inward.
  The layer→directory map is in `.claude/rules/clean-architecture.md` → "This project's layers".
- You **MUST NOT** put a business rule in a controller, route handler, UI component, database trigger,
  or ORM lifecycle hook.
- You **MUST NOT** serialize a domain entity to the wire or persist one by ORM reflection — map to a
  DTO at the boundary.
- Before you build, state the layers you touch and the ports you add (the plan template forces this).
  If a new dependency would point outward, stop and raise it before writing the code.
- This is enforced **mechanically** where the project has wired it: the architecture-boundary check in
  `CLAUDE.md` → Key Commands (a dependency-cruiser / import-linter / ArchUnit config) fails the build
  on an outward import. That check binds every contributor equally **only once it runs in required
  CI** — a client-side pre-commit hook is skippable with `--no-verify`, so CI is the plane that
  actually holds against a non-Claude agent. See "Enforcement — the honest version" below.

<!-- MIRROR:start — this block is copied verbatim into every tool-native file by scripts/sync-agents.sh. Edit here only; it is the "if you read nothing else" contract for tools that do not open AGENTS.md. -->
## If you read nothing else in this repo

**Before writing anything, open `AGENTS.md` at the repo root and read it fully.** The short version:

- **Read, in order:** `docs/claude/roadmap.md` (the plan) → `docs/claude/in-progress.md` (the queue +
  the exact next step) → the running worklog (`docs/claude/worklog.md` or the `CHANGELOG`
  `[Unreleased]` section) → `CLAUDE.md` (stack + commands) → the `.claude/rules/` module for what you
  touch.
- **Carry existing work forward.** The top of `in-progress.md` is the live task with its next step —
  continue it; do NOT open a parallel track for work already queued.
- **Keep the plan and worklog current in the SAME change as the code.** Shipped-but-unlogged = not done.
- **Clean Architecture is mandatory:** dependencies point inward only; business rules import no
  framework / ORM / HTTP / SDK; external concerns sit behind a port with an edge adapter.

### MUST NOT — hard guardrails

For Claude Code these are enforced by `.claude/settings.json`. **That permission gate binds only
Claude** — for every other tool these are advisory doctrine, and the only cross-tool enforcement is
whatever the repo has wired server-side (branch protection + required CI). Honor them as absolute:

- **NEVER** force-push, `git reset --hard` a shared branch, delete branches/tags, or rewrite published
  history.
- **NEVER** run a destructive database command: `db:push` / `db:reset` / `db:drop`, `prisma db push`,
  `prisma migrate reset`, `drizzle-kit push`, `alembic downgrade base`, `supabase db reset`, or raw
  `DROP`. Migrations are forward-only and reviewed.
- **NEVER** pipe the network to a shell (`curl … | bash`, `iwr … | iex`) or install from an untrusted
  source.
- **NEVER** read or print secrets (`.env`, `*.pem`, `id_rsa`, `credentials.json`), and never put a
  credential in a git remote URL or a commit.
- **NEVER** publish a package or deploy (`npm publish`, `cargo publish`, `docker push`, …) unless the
  task explicitly asks and a human has approved.
- **ALWAYS** stop and get human approval before any change that is destructive, irreversible, or
  outside the approved scope.
<!-- MIRROR:end -->

## Where everything lives

| You need | Read |
|---|---|
| The overall plan (initiatives) | `docs/claude/roadmap.md` |
| What to work on now | `docs/claude/in-progress.md` |
| What landed recently | `docs/claude/worklog.md` (or `CHANGELOG.md` `[Unreleased]`) |
| How to work (process) | `.claude/rules/workflow.md`, `quality-bar.md`, `git-workflow.md`, `documentation.md` |
| Architecture premise | `.claude/rules/clean-architecture.md` |
| Code / tests / errors | `.claude/rules/code-style.md`, `testing.md`, `error-handling.md` |
| Data & interfaces | `.claude/rules/database.md`, `data-modeling.md`, `api-design.md` |
| Stack, commands, structure | `CLAUDE.md` |
| Decisions & gotchas | `docs/claude/architecture.md`, `key-patterns.md` |

Deep rules are **not copied here** — they live once under `.claude/rules/` and are plain markdown any
agent can open. This file is the index, the onboarding order, and the guardrail; the modules are the depth.

## Enforcement — the honest version

Be clear-eyed about what actually stops a bad change, because half of these tools have no permission
model at all:

- **`.claude/settings.json`** is a real gate, but it binds **only Claude Code**. It does nothing to a
  Cursor, Codex, Copilot, Windsurf, Cline, or aider agent.
- For every other tool, the guardrails above are **doc-level MUST-NOT prose** — always in context (the
  `MIRROR` block is mirrored into each tool's native rules file), but advisory. A determined or
  confused agent can still run the command.
- **The only cross-tool enforcement is server-side:** branch protection on the default branch (blocks
  force-push and direct pushes no matter who typed them) and **required CI status checks** (test,
  typecheck, lint, the architecture-boundary check, secret scan) that block a merge regardless of tool.
  This repo ships a starter CI workflow at `scripts/templates/ci-verify.yml` and a pre-commit sample
  at `scripts/templates/pre-commit`; **turn them on and mark the CI checks required** — until you do,
  the only backstop against a non-Claude agent is the prose above. Do not assume a gate you have not
  wired.
