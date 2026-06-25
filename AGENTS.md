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
