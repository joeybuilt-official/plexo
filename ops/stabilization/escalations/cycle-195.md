---
cycle: 195
date: 2026-04-27
verdict: no-product-bug
related: cycle-194.md, cycle-193.md, cycle-192.md
---

# Cycle 195 Escalation — 2026-04-27

## Verdict
**No Plexo code bug.** Fourth consecutive recurrence of the cycle-192/193/194
harness/environment issue: the scenario harness cannot reach the Plexo API
on `localhost:3001` because the `plexo-api` container is bound
only to the internal docker network. The product tree is healthy and the
full test suite is GREEN. No commit is made.

## Reported failure
`ops/STATUS.md` cycle 195:

```
| Scenarios | 1 passed / 2 failed (33.3% pass rate) |
| Test Suite | GREEN |
| Security Probes | PASS |
| SLO Breaches | 1 |
Open Failures:
- [S-001] FAIL (45ms)
- [S-002] FAIL (1ms)
```

The 45 ms / 1 ms latencies are the same kernel-level ECONNREFUSED
signature documented in cycles 192–194 — not 200/4xx responses from
a running server.

## Root cause — host cannot reach the API container on `localhost:3001`

`docker ps` at 2026-04-27 ~18:15Z:

```
NAMES                    STATUS                    PORTS
plexo-api      Up 2 hours (healthy)      3001/tcp
service   Up 2 hours (healthy)      3001/tcp, 127.0.0.1:3002->3002/tcp
```

`plexo-api` exposes 3001 **only on the `joeybuilt_internal`
docker network** — there is no `127.0.0.1:3001->3001/tcp` host binding.

From the host:
```
$ curl -sS -m 5 http://localhost:3001/health
curl: (7) Failed to connect to localhost port 3001 after 0 ms: Couldn't connect to server

$ curl -sS -m 5 http://localhost:3002/health
{"status":"ok","version":"0.8.0-beta.6","uptime":5538,
 "services":{"postgres":{"ok":true},"redis":{"ok":true},
 "ai":{"ok":true},"embeddings":{"ok":true}},"registeredProfiles":0}
```

So:
- 1 ms (S-002) = kernel-level ECONNREFUSED — nothing listening on host:3001.
- 45 ms (S-001) = same, with one extra retry / DNS round-trip.

The Plexo API is up, healthy, and serving 200s on host port 3002 (via
the `cc-plexo-api` host binding). The scenario harness simply has no
route to `localhost:3001`.

## Why this is not a product bug

| Signal               | Result |
|----------------------|--------|
| Test Suite (cycle 195) | **GREEN** |
| Container health     | **healthy** — uptime ~2h, all sub-services ok |
| `localhost:3002/health` | 200 — postgres, redis, ai, embeddings all ok |
| Security probes      | **PASS** — 0 findings |
| Scenario S-013       | **PASS** (the one scenario that does not hit `localhost:3001`) |

If the public API were broken, S-013 would fail and the in-container
`/health` would not return 200. Both indicate the product code is fine.
The harness's host→container path on port 3001 is the only thing failing.

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
4. A "FAILING test first" cannot be written in this repo because the
   failure is observable only through a network path that this repo
   does not own.

## Recommended action (in `plexo-internal` / `pushd/infra`)
Pick one — either is sufficient. These are the same recommendations
issued in cycles 192–194:

- **Harness side** (`plexo-internal/ops/stabilization/fleet/scenario-runner.ts`):
  change the default `API_URL` to a path that resolves from the host.
  Options:
  - run the harness inside `joeybuilt_internal` (e.g. via
    `docker exec infra-command-engine ...`) and default to
    `http://plexo-api:3001`, or
  - default to `http://localhost:3002` (the `cc-plexo-api` host
    binding that already exists), or
  - add a readiness probe + retry loop so a transient
    connection-refused does not fail S-001/S-002.
- **Infra side** (`pushd/infra/docker-compose.prod.yml`): add
  `127.0.0.1:3001:3001` to the `plexo-api` service port mapping so
  `localhost:3001` from the VPS host reaches the SaaS API the same
  way `cc-plexo-api` already exposes 3002.

Until one of those two changes lands, every scheduled cycle will keep
filing the same S-001/S-002 escalation against this repo. This is now
the **fourth consecutive cycle** with the same root cause — the issue
is not self-healing and requires action outside this repo.

## Verification at 2026-04-27 ~18:15Z
| Signal             | Result |
|--------------------|--------|
| `docker ps`        | plexo-api healthy, uptime ~2h, no host:3001 binding |
| Host curl :3001    | ECONNREFUSED (0 ms) |
| Host curl :3002    | 200, all sub-services ok |
| Cycle 195 tests    | **GREEN** (per STATUS.md) |
| Cycle 195 security | **PASS** (per STATUS.md) |

No code changes were made; no commit was pushed.
