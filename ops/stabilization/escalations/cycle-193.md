---
cycle: 193
date: 2026-04-27
verdict: no-product-bug
related: cycle-192.md
---

# Cycle 193 Escalation — 2026-04-27

## Verdict
**No Plexo code bug.** The reported S-001 / S-002 failures are a recurrence
of the cycle-192 harness/environment issue. The product tree is healthy
and the full test suite is GREEN. No commit is made.

## Reported failure
`ops/stabilization/results/cycle-0193.json`:

```json
"scenarios": { "passed": 1, "failed": 2,
  "errors": ["[S-001] FAIL (48ms)", "[S-002] FAIL (2ms)"] },
"tests":     { "passed": true,
  "summary": "Tasks: 8 successful, 8 total ... Time: 46.545s" },
"security":  { "passed": true, "findings": [] },
"sloBreaches": ["2 scenario failures"]
```

The 48 ms / 2 ms latencies are the same connection-refused / partial-
handshake signature documented in `cycle-192.md` — they are not 200/4xx
responses from a running server.

## Root cause — host cannot reach the API container on `localhost:3001`

`scenario-runner.ts` (`plexo-internal/ops/stabilization/fleet/`) uses
`API_URL = process.env.API_URL || 'http://localhost:3001'`. S-001 hits
`/health` and S-002 hits `/api/v1/metrics` against that URL.

Current container state:

```
$ docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
plexo-api      Up 25 minutes (healthy)   3001/tcp
service   Up 25 minutes (healthy)   3001/tcp, 127.0.0.1:3002->3002/tcp
...
```

`plexo-api` exposes port 3001 **only on the `joeybuilt_internal`
docker network** — there is no `127.0.0.1:3001->3001/tcp` host binding.
From the host:

```
$ curl -sS http://localhost:3001/health
curl: (7) Failed to connect to localhost port 3001: Connection refused
```

But the container itself is healthy:

```
$ docker exec plexo-api node -e "require('http').get(...)"
STATUS: 200 BODY: {"status":"ok","version":"0.8.0-beta.6","uptime":1526,
 "services":{"postgres":{"ok":true},"redis":{"ok":true},
 "ai":{"ok":null},"embeddings":{"ok":true}},"registeredProfiles":4}
```

So:
- 2 ms (S-002) = kernel-level ECONNREFUSED — nothing listening on host:3001.
- 48 ms (S-001) = same, with one extra TCP retry / DNS round-trip.

The Plexo API itself is up, healthy, and serving requests on the
internal network. The scenario harness simply has no route to it.

## Why this is not a product bug
| Signal               | Result |
|----------------------|--------|
| `pnpm test`          | **GREEN** — 8/8 tasks, full suite passes (46.545s) |
| Container health     | **healthy** — uptime 1526s, all sub-services ok |
| `/health` (in-net)   | 200 — postgres, redis, embeddings ok |
| Security probes      | **PASS** — 0 findings |
| Scenario S-013       | **PASS** (the one scenario that does not hit `localhost:3001`) |

If the public API were broken, `S-013` would fail and the in-container
`/health` probe would not return 200. Both indicate the product code is
fine; the harness's host→container path is the only thing failing.

## Why no fix is committed
1. The defect is in `plexo-internal/ops/stabilization/fleet/scenario-
   runner.ts` (default `API_URL`) and/or the `plexo-api`
   port-binding in `pushd/infra/docker-compose.prod.yml`. Both files
   are outside this session's allowed working directory
   (`/opt/service/plexo`).
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

- **Harness side** (`plexo-internal/ops/stabilization/fleet/scenario-
  runner.ts`): change the default `API_URL` to a path that resolves
  from the host. Options:
  - run the harness inside `joeybuilt_internal` (e.g. via `docker exec
    infra-command-engine ...`) and default to
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

The cycle-48..67 escalations and cycle-192 already prescribe variants
of the harness fix; this is the same root cause surfacing again.

## Verification at 2026-04-27 ~17:30Z
| Signal             | Result |
|--------------------|--------|
| `docker ps`        | plexo-api healthy, uptime ~25m, no host:3001 binding |
| In-container /health | 200, all sub-services ok |
| Host curl :3001    | ECONNREFUSED |
| Cycle 193 tests    | GREEN (8/8) |
| Cycle 193 security | PASS |

No code changes were made; no commit was pushed.
