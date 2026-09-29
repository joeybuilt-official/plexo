# Infrastructure

How Plexo runs and deploys: the surfaces, the data stores, and the operational constraints. No
secrets and no operator-specific identifiers belong in this file — the repo is public.

## Runtime shape

| Surface | Where | Notes |
|---|---|---|
| Web dashboard | `apps/web` — Next.js 16 / React 19 / Tailwind 4 | Authenticated client |
| API | `apps/api` — Express | Route modules mounted under the API app |
| Knowledge-graph sidecar | `services/graphiti-sidecar` — FastAPI + FalkorDB | Graphiti |
| Mobile | `apps/mobile` — Flutter | |
| Desktop | `apps/desktop` — Electron shell | |
| CLI | `apps/cli` | |
| Extensions | `extensions/core` | PEX extensions and bridges |

## Data stores

- **PostgreSQL + pgvector** — primary store, accessed through Drizzle in `packages/db`.
  Forward-only migrations; apply with `pnpm db:migrate`.
- **FalkorDB / Graphiti** — knowledge-graph store behind the sidecar.
- **Redis / Valkey** — cache and queues. Queue ports and Inngest wiring live in `packages/queue`.

## Deployment

Self-hosting is supported and documented in `docs/self-host.md`. The stack ships as a Docker Compose
project (`docker-compose.yml`) with profiles; local loopback development uses
`docker-compose.dev.yml`, and `scripts/install.sh` bootstraps a self-host install.

**Two profiles are required together** for a working self-host boot: `--profile selfhosted` and
`--profile object-storage`. A bare `docker compose up -d` publishes no web port and starts no MinIO,
even though `STORAGE_ENDPOINT` defaults to the MinIO service.

## CI topology

| Workflow | Trigger | Runner | Purpose |
|---|---|---|---|
| `pr-gate.yml` | `pull_request` | hosted `ubuntu-latest` | Required `verify` check: typecheck, arch, db drift, tests |
| `ci.yml` | `push: main` | self-hosted | Full gate including `lint` + integration (needs CI Postgres/Redis) |
| `infra-scan.yml` | — | — | Infrastructure-identifier scan |
| `workflow-health.yml`, `changelog-check.yml`, `agent-regression.yml`, `visual-regression.yml`, `release.yml`, `graphiti-upstream-watcher.yml` | — | — | Supporting gates |

**INVARIANT.** `ci.yml` must never gain a `pull_request` trigger, and `pr-gate.yml` must never move
onto a self-hosted runner or gain a `secrets.*` dependency. The repo is public, so a PR trigger
resolves the workflow from the fork's merge commit and would hand an untrusted shell to a host-root-
equivalent runner.

Branch protection on `main`: required status check `verify`, force-push and deletion disabled,
`enforce_admins` **on** — so a direct push is rejected even for the owner. Land changes via branch
+ PR.
