---
cycle: 194
date: 2026-04-27
verdict: no-product-bug
related: cycle-193.md, cycle-192.md
---

# Cycle 194 Escalation — 2026-04-27

## Verdict
**No Plexo code bug.** Same harness/environment issue as cycles 192 and 193:
the scenario harness cannot reach the Plexo API on `localhost:3001` because
the `plexo-api` container is only bound to the internal docker
network. The product tree is healthy and all tests are GREEN. No commit.

## Reported failure
`ops/stabilization/results/cycle-0194.json`:

```json
"scenarios": { "passed": 1, "failed": 2,
  "errors": ["[S-001] FAIL (44ms)", "[S-002] FAIL (2ms)"] },
"tests":     { "passed": true,
  "summary": "Tasks: 8 successful, 8 total ... Time: 47.108s" },
"security":  { "passed": true, "findings": [] },
"sloBreaches": ["2 scenario failures"]
```

The 44 ms / 2 ms latencies are kernel-level ECONNREFUSED — the same
signature documented in cycles 192 and 193. Not 200/4xx responses
from a running server.

## Root cause — host cannot reach the API container on `localhost:3001`

`docker ps` at 2026-04-27 17:40Z:

```
NAMES                    STATUS                    PORTS
plexo-api      Up 58 minutes (healthy)   3001/tcp
service   Up 58 minutes (healthy)   3001/tcp, 127.0.0.1:3002->3002/tcp
```

`plexo-api` exposes 3001 **only on the `joeybuilt_internal`
docker network** — there is no `127.0.0.1:3001->3001/tcp` host binding.

From the host:
```
$ curl -sS -m 5 http://localhost:3001/health
curl: (7) Failed to connect to localhost port 3001 after 0 ms: Couldn't connect to server

$ curl -sS -m 5 http://localhost:3002/health
{"status":"ok","version":"0.8.0-beta.6","uptime":3490,
 "services":{"postgres":{"ok":true},"redis":{"ok":true},
 "ai":{"ok":true},"embeddings":{"ok":true}},"registeredProfiles":0}
```

So:
- 2 ms (S-002) = kernel-level ECONNREFUSED — nothing listening on host:3001.
- 44 ms (S-001) = same, with one extra retry / DNS round-trip.

The Plexo API itself is up, healthy, and serving 200s on port 3002
(via the `cc-plexo-api` host binding). The scenario harness simply
has no route to `localhost:3001`.

## Why this is not a product bug

| Signal               | Result |
|----------------------|--------|
| `pnpm typecheck`     | **GREEN** — 18/18 tasks (after clearing stale `apps/web/.next`) |
| `pnpm test`          | **GREEN** — 8/8 tasks, 169/169 SCL tests, 41.965s |
| Container health     | **healthy** — uptime ~58m, all sub-services ok |
| `localhost:3002/health` | 200 — postgres, redis, ai, embeddings ok |
| Security probes      | **PASS** — 0 findings |
| Scenario S-013       | **PASS** (the one scenario that does not hit `localhost:3001`) |

If the public API were broken, S-013 would fail and the
`localhost:3002/health` probe would not return 200. Both indicate the
product code is fine; the harness's host→container path on port 3001
is the only thing failing.

### Note: stale Next.js build artifact
On a cold typecheck the first run failed inside
`apps/web/.next/types/validator.ts`, complaining about modules under
`src/app/app/ops/...` and `src/app/api/ops/...` that no longer exist
in the source tree. This is leftover Next.js generated output from a
previous build of the ops surface. Removing `apps/web/.next` and
re-running `pnpm typecheck` gives a clean 18/18 pass. This is a build
artifact pollution issue, not a product bug, and is not what the
S-001/S-002 scenarios are reporting.

## Why no fix is committed

1. The defect is in `plexo-internal/ops/stabilization/fleet/scenario-runner.ts`
   (default `API_URL = http://localhost:3001`) and/or the
   `plexo-api` port-binding in
   `pushd/infra/docker-compose.prod.yml`. Both files are outside this
   session's allowed working directory (`/opt/service/plexo`).
2. Rule 7 forbids touching the public API shape. Adding a host
   port-binding to the prod compose file is an infra/ops change, not
   a product fix, and would not belong in the public `plexo` tree.
3. Rule 10: keep changes minimal — fix only what's broken. Nothing in
   `/opt/service/plexo` is broken.

A "FAILING test first" cannot be written in this repo because the
failure is observable only through a network path that this repo does
not own.

## Recommended action (in `plexo-internal` / `pushd/infra`)
Pick one — either is sufficient:

- **Harness side** (`plexo-internal/ops/stabilization/fleet/scenario-runner.ts`):
  change the default `API_URL` to a path that resolves from the host.
  Options:
  - run the harness inside `joeybuilt_internal` (e.g. via
    `docker exec infra-command-engine ...`) and default to
    `http://plexo-api:3001`, or
  - default to `http://localhost:3002` (the `cc-plexo-api` host
    binding that already exists), or
  - add a readiness probe + retry loop so a transient connection-
    refused does not fail S-001/S-002 (also covers the cycle-192
    deploy-window race).
- **Infra side** (`pushd/infra/docker-compose.prod.yml`): add
  `127.0.0.1:3001:3001` to the `plexo-api` service port mapping so
  `localhost:3001` from the VPS host reaches the SaaS API the same
  way `cc-plexo-api` already exposes 3002.

The cycle-48..67 escalations and cycles 192–193 already prescribe
variants of the harness fix; this is the same root cause surfacing
again. Until one of those two changes lands, every scheduled cycle
will keep filing the same S-001/S-002 escalation against this repo.

## Verification at 2026-04-27 ~17:40Z
| Signal             | Result |
|--------------------|--------|
| `docker ps`        | plexo-api healthy, uptime ~58m, no host:3001 binding |
| Host curl :3001    | ECONNREFUSED (0 ms) |
| Host curl :3002    | 200, all sub-services ok |
| Cycle 194 typecheck | GREEN (18/18, after `.next` clear) |
| Cycle 194 tests    | GREEN (8/8, 169/169 SCL) |
| Cycle 194 security | PASS |

No code changes were made; no commit was pushed.
