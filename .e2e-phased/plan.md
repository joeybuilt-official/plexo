# Plexo — Full E2E Readiness Pass

> **2026-06-04.** Goal set after Phase 7 closed. Operator wants thorough E2E ("every button, every piece of functionality") against an ephemeral instance — NOT prod — to confirm the software is ready for use.

---

## Goal

Stand up an ephemeral throwaway Plexo stack, run the existing Playwright suite (p0–p9 + audits) to green, supplement with exploratory checks, and report a readiness verdict with a prioritized defect list.

---

## Hard environment facts (validated 2026-06-04)

- **Build constraint:** the app-stack container's docker socket is a PROXY — `build`/`exec`/`cp` return 403. All build/up/exec must run on the server via `ssh <server>`. (Read-only `docker ps/logs/inspect` work from the container.)
- **Port conflict:** the server host `:3000` is held by `karakeep-main`. `:3001`, `:13000`, `:13001` are FREE. → remap the e2e **web** service to host `13000`; api can keep `3001`.
- **Toolchain:** the server host has `docker` + `compose v2.40.3` + `node`, but **no pnpm**. Use `corepack enable pnpm` (node present). Playwright needs `pnpm exec playwright install --with-deps chromium`.
- **e2e stack (`docker-compose.e2e.yml`) is self-contained/throwaway:** own `postgres` (pgvector pg16, db=plexo, pw=`e2e-test-password`), `redis` (valkey), `migrate` (runs migrations), `api` (Dockerfile.api, :3001), `web` (Dockerfile.web, :3000). Default `PLEXO_SERVICE_KEY=e2e0…service`. **No falkordb / graphiti sidecar** → graph features (critical-path data, cypher, triplets) will be ABSENT/empty in this stack; UI should degrade gracefully, not crash.
- **Source tree to build from:** deployed clone `/srv/plexo/source/plexo` (at main 7651a12 = current prod). The local P3 cypher-cli fix is NOT needed for the UI suite. If you want the fix included, sync it in first.
- **Suite:** `tests/e2e/` has p0-vps, p1-a2a, p1-stability, p2-inference, p2-skills, p3-badge/skills, p4-agents/analytics, p5-selfhost, p6-analytics, p7/p8-launch, p9-qa-saas (37), audit-p2/p3/p4, behavior, intelligence, fallback-routing, critical-path(s), plan-card, work-detail, levio-handoff. `auth.setup.ts` handles login; `_helpers.ts` shared. ~150 tests total.
- **Driving:** `pnpm e2e:test` runs against `E2E_BASE_URL`/`E2E_API_URL` (already parameterized). With web remapped to 13000: `E2E_BASE_URL=http://127.0.0.1:13000 E2E_API_URL=http://127.0.0.1:3001`. Stack binds loopback only, so Playwright must run ON the server (the operator's browser can't reach the server loopback). Browser-based exploratory checks would need a 0.0.0.0 bind or a tunnel.

---

## Phases

### Phase 1 — Ephemeral stack up on the server
- Scope: write a compose override remapping web host port 3000→13000 (api stays 3001); `ssh <server>` into the source clone; `docker compose -f docker-compose.e2e.yml -f <override> -p plexo-e2e up -d --build --wait`. Confirm api `/health` + web reachable on 127.0.0.1:13000/3001.
- Deps: none
- Subagents: none
- Exit: api + web healthy on loopback; throwaway DB migrated.
- Status: pending

### Phase 2 — Test toolchain on the server
- Scope: `corepack enable pnpm`; `pnpm install` (frozen) in the clone; `pnpm exec playwright install --with-deps chromium`.
- Deps: none (parallel to Phase 1)
- Exit: `pnpm exec playwright --version` works; chromium installed.
- Status: pending

### Phase 3 — Run suite + triage
- Scope: `E2E_BASE_URL=http://127.0.0.1:13000 E2E_API_URL=http://127.0.0.1:3001 pnpm exec playwright test`. Capture pass/fail per spec. Triage failures: distinguish (a) real app defects, (b) env gaps (missing falkordb/sidecar → expected), (c) flaky/timeout.
- Deps: Phase 1 + 2
- Exit: full run recorded; failures categorized.
- Status: pending

### Phase 4 — Exploratory supplement
- Scope: cover gaps the suite doesn't (any button/flow not asserted). Decide mechanism: either bind web 0.0.0.0 + drive via Claude-in-Chrome, or scripted checks on the server.
- Deps: Phase 3
- Exit: every primary nav/section + key actions exercised; defects logged.
- Status: pending

### Phase 5 — Teardown + readiness report
- Scope: `docker compose -p plexo-e2e down -v`; remove temp toolchain artifacts if desired. Write readiness verdict + prioritized defect list.
- Deps: Phase 4
- Exit: stack torn down; report delivered.
- Status: pending

---

## One-way doors ⚠
None. All on a throwaway project (`plexo-e2e`, `down -v` discards). Building images consumes CPU/disk on the prod host — run when the server is not under load.

## Operator sign-off gates
- Before Phase 1 build: confirm the server has headroom for an image build + ephemeral stack.

## Decisions log
- 2026-06-04 — Operator chose: ephemeral instance (not prod) for E2E; run as a dedicated session; this plan captures the validated bring-up recipe.
