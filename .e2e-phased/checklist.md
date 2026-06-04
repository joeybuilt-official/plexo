# Plexo — Full E2E Readiness Pass — checklist

## Phase 1 — Ephemeral stack up on the host
- [ ] Write compose override: web host port 3000→13000 (api keeps 3001)
- [ ] `ssh <server>` → source clone → `docker compose -f docker-compose.e2e.yml -f <override> -p plexo-e2e up -d --build --wait`
- [ ] api `/health` 200 on 127.0.0.1:3001; web reachable on 127.0.0.1:13000
- [ ] migrate service completed (throwaway DB migrated)

## Phase 2 — Test toolchain on the host
- [ ] `corepack enable pnpm`
- [ ] `pnpm install` in clone
- [ ] `pnpm exec playwright install --with-deps chromium`

## Phase 3 — Run suite + triage
- [ ] Run full suite with E2E_BASE_URL=127.0.0.1:13000 / E2E_API_URL=127.0.0.1:3001
- [ ] Record pass/fail per spec
- [ ] Categorize failures: real defect / env-gap (no falkordb) / flake

## Phase 4 — Exploratory supplement
- [ ] Decide drive mechanism (0.0.0.0 bind + Chrome, or scripted)
- [ ] Exercise every primary nav/section + key actions not covered by suite
- [ ] Log defects

## Phase 5 — Teardown + report
- [ ] `docker compose -p plexo-e2e down -v`
- [ ] Readiness verdict + prioritized defect list
