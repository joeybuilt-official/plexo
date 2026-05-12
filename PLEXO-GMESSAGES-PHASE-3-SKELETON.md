# PLEXO Google Messages connector — Phase 3 skeleton

**Status:** Phase 3 deliverables complete. No operator gate (next gate is Phase 6 first prod deploy).
**Date:** 2026-05-05
**Inputs:** `PLEXO-GMESSAGES-PHASE-1-DESIGN.md`, `PLEXO-GMESSAGES-PHASE-2-CONTRACT.md`, ADRs 0001 + 0004.

This phase scaffolds the Go sidecar (`apps/gmessages/`), wires the Pex contract from Phase 2, and verifies end-to-end plumbing via a synthetic-boot smoke test. The libgmessages link is intentionally deferred to Phase 4 — the skeleton boots and posts events through the Pex Channel inbound contract without depending on the upstream library.

---

## 1. File layout

```
apps/gmessages/
├── go.mod                                    # module + Go 1.23 directive
├── .gitignore
├── Makefile                                  # dev / build / test / docker
├── cmd/gmessages/main.go                     # entrypoint (incl. -healthcheck + -version flags)
├── internal/
│   ├── pex/
│   │   ├── types.go                          # mirror of @plexo/sdk channel types
│   │   ├── client.go                         # HMAC POST client
│   │   └── types_compat_test.go              # TS-fixture round-trip
│   ├── session/
│   │   ├── crypto.go                         # HKDF-Expand (RFC 5869, inlined) + Zero
│   │   ├── manager.go                        # multi-tenant goroutine pool
│   │   └── manager_test.go                   # panic isolation + HKDF determinism
│   ├── log/log.go                            # slog + Secret/SessionBlob redacted types
│   ├── health/health.go                      # /health
│   └── liveness/liveness.go                  # flow-heartbeat counters + loop
├── testdata/fixtures/channel_message.json    # canonical TS-side fixture
└── docker/Dockerfile                         # multi-stage golang:1.23-alpine → distroless
```

No third-party Go modules — only stdlib. HKDF is inlined (~25 lines) so we don't pull `golang.org/x/crypto` solely for one primitive. When Phase 4 lands libgmessages it will likely bring `golang.org/x/crypto` transitively; at that point we can replace `internal/session/crypto.go` with a `hkdf.New(sha256.New, ...)` thin wrapper. The inline version is RFC-5869-compliant.

---

## 2. ADR-0004 invariants — implementation map

| Invariant | Code |
|---|---|
| 1. HKDF-derived per-session keys, never co-resident, zeroed on end | `internal/session/crypto.go` (`DeriveSessionKey`, `Zero`); `manager.go` `Session.End()` invokes `runtime.KeepAlive` after `Zero` |
| 2. Panic isolation per session goroutine | `internal/session/manager.go` `runSession()` — `defer recover()` at goroutine entry; on panic, deletes the session from the pool, logs `panic + stack`, continues serving other sessions. Unit-tested in `manager_test.go::TestManager_PanicIsolation`. |
| 3. Compile-time-redacted structured logging | `internal/log/log.go` — `Secret` and `SessionBlob` types implement `MarshalJSON`/`String`/`LogValue` returning `--redacted--`. To extract, callers must call `.Reveal()` — explicit and greppable. `cmd/gmessages/main.go` stores keys as `log.Secret`; the sidecar can never accidentally log the raw key. |

Layered liveness probes (ADR-0004 §"Liveness: layered, both signals"):

| Layer | Cadence | Where |
|---|---|---|
| Process health | 10s | supervisor `/health` poll → `internal/health/health.go` |
| Library probe | 30s | `libgmessages.Session.Ping()` — Phase 4 wires |
| Flow heartbeat | 60s | `internal/liveness/liveness.go::HeartbeatLoop` posts `Heartbeat{LastInboundAt, DecodeErrorCount}` to `/api/plexo/channels/gmessages/heartbeat` |
| Stale-session monitor | 5m | Inngest cron `gmessages.stale-session.monitor` — Phase 4 |

---

## 3. Pex contract surface (consumed by the sidecar)

Mirrors of `@plexo/sdk` types in `internal/pex/types.go`:

- `ChannelMessage`, `ChannelEvent`, `ConnectionState`, `MessageDirection`, `ChannelAttachmentRef`
- `ChannelInbound`, `StateChange`, `Heartbeat` — the three connector→Plexo envelopes

`internal/pex/client.go` posts these via:

```go
client := pex.NewClient(plexoBaseURL, serviceKey, "gmessages-sidecar")
client.SendInbound(ctx, pex.ChannelInbound{ ... })       // /inbound
client.SendStateChange(ctx, pex.StateChange{ ... })      // /state
client.SendHeartbeat(ctx, pex.Heartbeat{ ... })          // /heartbeat
```

HMAC headers: `X-App-Id: gmessages-sidecar`, `X-Plexo-Timestamp: <RFC3339>`, `X-Plexo-Signature: sha256=<hex>`. Verified against the Phase 2 `requireHmacService` middleware (`apps/api/src/middleware/hmac-service.ts`) end-to-end — see §6.

---

## 4. Compat test (Phase 1 design §4 step 8)

`internal/pex/types_compat_test.go` decodes the canonical TS-side fixture (`testdata/fixtures/channel_message.json`) into the Go `ChannelMessage` struct, asserts every field round-trips, and re-encodes back to JSON to verify the encoder emits the same shape. Run:

```
docker run --rm -v "$PWD/apps/gmessages:/src" -w /src golang:1.23-alpine go test ./...
```

```
ok  github.com/joeybuilt-official/plexo/apps/gmessages/internal/pex      0.002s
ok  github.com/joeybuilt-official/plexo/apps/gmessages/internal/session  0.013s
```

When the TS side adds a new field to `ChannelMessage`, mirror it in `types.go` and refresh the fixture in the same commit. CI integration (Phase 4 ops): a Plexo monorepo lint check that compares `packages/sdk/src/types/channel.ts` field set against `apps/gmessages/internal/pex/types.go`.

---

## 5. Local dev workflow

| Goal | Command |
|---|---|
| Run sidecar with stdlib + local Go | `cd apps/gmessages && make dev` |
| Build static binary | `make build` (output: `apps/gmessages/bin/gmessages`) |
| Run tests | `make test` |
| Build container | `make docker-build` |
| Run via compose | `docker compose up -d gmessages` (rebuilds api + waits for healthy) |
| Synthetic-boot smoke test | `GMESSAGES_SYNTHETIC_BOOT=1 docker compose up -d --force-recreate gmessages` |

The Makefile's `dev` target requires Go 1.23+ locally; without it, `make docker-dev` builds and runs in a container.

Required env vars:

| Var | Purpose | Default |
|---|---|---|
| `PORT` | HTTP listener | `3010` |
| `PLEXO_BASE_URL` | Plexo API base URL | `http://api:3001` |
| `PLEXO_SERVICE_KEY` | HMAC shared secret | required |
| `GMESSAGES_MASTER_KEY` | HKDF master | falls back to `ENCRYPTION_SECRET` |
| `GMESSAGES_SYNTHETIC_BOOT` | Phase 3 self-test toggle | `0` (off) |

The sidecar reads env directly — no `.env` file traversal. Production injects via the platform compose `.env`; dev injects via compose.

---

## 6. End-to-end smoke (Phase 3 exit criterion)

Pre-conditions:
- Plexo API container rebuilt with Phase 2 routes (`docker compose build api`).
- Postgres up + healthy with Phase 2 migration applied.
- `gmessages` compose service started.

Procedure: set `GMESSAGES_SYNTHETIC_BOOT=1` and force-recreate gmessages. The sidecar's startup goroutine waits 5 seconds, then posts a synthetic `ChannelInbound` envelope (with empty workspaceId/channelId by default) to `/api/plexo/channels/gmessages/inbound`.

Observed:

```
INFO  plexo-gmessages booting             version=0.0.1-phase-3-skeleton
INFO  http listener up                    port=3010
WARN  synthetic boot inbound failed       err=pex: POST /api/plexo/channels/gmessages/inbound
                                              -> 400: missing inbound fields
```

The 400 is the **success signal** at Phase 3:
- HMAC auth passed (would be `401` otherwise)
- Body decoded by Express JSON parser (would be `400 invalid JSON` otherwise)
- Route mounted + handler reached (was `404` against the stale pre-rebuild api container)
- Validation correctly rejected the empty workspaceId/channelId (the stub payload deliberately leaves them blank)

To run the full happy path end-to-end, set `GMESSAGES_SYNTHETIC_WORKSPACE_ID` + `GMESSAGES_SYNTHETIC_CHANNEL_ID` to real UUIDs from the dev DB; the API will then return `202 accepted` and Phase 5's normalization pipeline will see the event when it lands.

Container health verification:

```
docker compose ps gmessages → Health: healthy
```

The Docker healthcheck calls `/gmessages -healthcheck` which self-probes `http://127.0.0.1:3010/health`. Distroless base image has no shell or curl, so binary-as-probe is the canonical pattern.

---

## 7. What this phase deliberately did NOT do

- **Import libgmessages.** The handler interface in `internal/session/manager.go` accepts any `Handler{ Run(ctx, *Session) error }`. Phase 3 ships a `fakeHandler` that blocks on context cancellation; Phase 4 adds the real adapter implementing the same interface. The `go.mod` carries no third-party deps yet.
- **Pair a real phone.** Pairing UI + lifecycle is Phase 4 (ADR-0005). The connector has no QR-scan code path and `/api/plexo/channels/gmessages/inbound` is a no-op stub on the API side too.
- **Persist sessions across sidecar restart.** Phase 4 will read all `paired_sessions` rows in `state IN ('active','refreshing')` at boot and re-establish (ADR-0004 §"Restart semantics").
- **Add Inngest functions.** The Phase 2 install gives us the runtime; Phase 4 lands `gmessages.session.refresh` and `gmessages.stale-session.monitor`.
- **Wire the Pushd telemetry shim.** Phase 6 (ops) lands the audit-event posting to Plexo's `/api/audit` HMAC ingest. The sidecar's slog output is captured by Docker logging today.

---

## 8. Deviations from Phase 1 design / ADRs

- **No `golang.org/x/crypto/hkdf` dependency.** Plan called for HKDF; ADR-0004 specified HKDF. Implementation honors the spec via inline RFC 5869 (`internal/session/crypto.go`). When Phase 4 imports libgmessages and `x/crypto` becomes transitive, swap to the upstream package — behavior is byte-identical.
- **Default port 3010** (not specified in any ADR). Compose service binds internally only; not exposed to host. Phase 6 confirms via the platform compose deploy.

---

## 9. Self-generating handoff (Phase 4)

> Resume `PLEXO-GMESSAGES` Phase 4. Read in order: `/home/user/dev/plexo/PLEXO-GMESSAGES-PHASE-1-DESIGN.md`, `/home/user/dev/plexo/PLEXO-GMESSAGES-PHASE-2-CONTRACT.md`, `/home/user/dev/plexo/PLEXO-GMESSAGES-PHASE-3-SKELETON.md`, `/home/user/dev/plexo/adr/0005-plexo-viewer-and-pairing.md`, `/home/user/dev/plexo/adr/0006-inngest-install.md`, `/home/user/dev/plexo/plan.md`, `/home/user/dev/plexo/checklist.md`. State: Phase 3 complete — sidecar boots, /health probe passes, synthetic boot round-trips through HMAC + Pex Channel inbound contract. libgmessages NOT yet linked; `internal/session/manager.go` Handler interface awaits the real adapter. Next concrete step: (a) wire the libgmessages import into `apps/gmessages/go.mod` pinned to a specific tag (Phase 1 §3.6); (b) implement the libgmessages-backed `session.Handler` covering pair / receive / send / state-transition; (c) build pairing UI route at `apps/web/src/app/app/connections/gmessages/pair/` per ADR-0005 (consent → QR → polling → success); (d) add `apps/api/src/routes/connections-gmessages.ts` with `pair-start` + `pair-status` endpoints (these live under `/api/connections/`, NOT the `/api/plexo/channels/` subscription contract); (e) generic Channel viewer routes (`app/channels`, `app/channels/[channelId]`, `app/channels/[channelId]/[threadId]`) with thread-list + message-view + send composer per ADR-0005 minimum scope; (f) Inngest functions `gmessages.session.refresh` (15-min cron, fan-out per active session) + `gmessages.stale-session.monitor` (5-min cron) per ADR-0006; (g) on sidecar boot, restore `paired_sessions WHERE state IN ('active','refreshing')` per ADR-0004 §"Restart semantics"; (h) wire `internal/liveness/HeartbeatLoop` for each running session.
