# Contributing to Plexo

Plexo is open-source under MIT. This repo is the self-hosted Plexo platform. Managed-cloud features live in a separate private repository.

## What do you want to do?

```
I want to...
├── Report a bug       → Open a GitHub Issue
├── Fix a bug          → Fork → branch → PR against main
├── Propose a feature  → Open a GitHub Discussion first
├── Build an extension → See docs/extensions.md
└── Ask a question     → GitHub Discussions → Q&A category
```

## Dev Environment Setup

**Prerequisites:** Node.js 22+, pnpm 10+, Docker (for PostgreSQL + Valkey).

```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
cp .env.example .env          # configure your local env
docker compose up -d           # postgres + valkey
pnpm install
pnpm dev
```

## Commands

```bash
pnpm dev              # start all apps in dev mode
pnpm test             # unit tests (Vitest)
pnpm test:e2e         # Playwright E2E (requires running stack)
pnpm typecheck        # tsc --noEmit across all packages
pnpm build            # production build
```

## Submitting a PR

1. Fork the repo, branch from `main`
2. Make your changes
3. Pass the ship gate (see below)
4. Submit a PR with a clear description of **what** and **why**
5. Sign off every commit (DCO)

### Commit Format

```
<type>(<scope>): <what changed>

<why — one sentence>

Signed-off-by: Your Name <your@email.com>
```

**Types:** `fix`, `feat`, `refactor`, `test`, `docs`, `chore`, `perf`, `security`
**Scopes:** `agent`, `web`, `api`, `db`, `sdk`, `mcp`, `queue`, `infra`, `ui`

Use `git commit -s` to add the sign-off automatically.

### Ship Gate

All must pass before your PR will be reviewed:

- [ ] `pnpm test` — all tests pass, none skipped
- [ ] `pnpm typecheck` — no type errors
- [ ] `pnpm build` — clean build
- [ ] No unintended changes in the diff

### DCO (Developer Certificate of Origin)

All commits must include a `Signed-off-by` line. This certifies you have the right to submit the code under the project's license. No CLA required.

## PR Review Process

- First response within **48 hours**
- Maintainers may request changes, suggest alternatives, or close with explanation
- One approval required to merge
- Squash merge to `main`

## Code Rules

- TypeScript strict mode. No `any` without an inline comment.
- Drizzle for all DB access. No raw SQL except pgvector operations.
- shadcn/ui for all new UI components. Tailwind only.
- All new source files must include the SPDX header:

```typescript
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
```

- Do not introduce copyleft (GPL/AGPL) dependencies into MIT-licensed packages; the entire repository is MIT, with no carve-out. See [LICENSING.md](LICENSING.md).
- No TODOs merged to main.

## Reporting Bugs

Open a GitHub Issue with:
- What you expected
- What actually happened
- Steps to reproduce
- Plexo version

## Security Issues

Do **not** open a public issue. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
