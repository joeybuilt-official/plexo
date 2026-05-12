# PLEXO Google Messages connector — checklist

Flat ordered work list. Tick as items complete; do not batch. Phase numbering matches `plan.md`.

## Phase 0 — Audit (read-only)

- [x] OSS benchmark (mautrix-gmessages, mautrix-imessage, matrix-appservice-sms, KDE Connect/GSConnect, Beeper)
- [x] Plexo internal inventory (Pex spec, channels, connections, crypto, schema, queue, telemetry, Better Auth, deploy)
- [x] Levio internal inventory (IA, email surface, notifications, search, Pex consumer pattern, Inngest, deploy)
- [x] Audit-time conflicts identified (11 items in audit §0)
- [x] Open questions drafted (15 items in audit §4)
- [x] Pre-mortem ADR `adr/0001-gmessages-go-sidecar.md`
- [x] `plan.md`, `checklist.md`, `PLEXO-GMESSAGES-PROGRESS.md` written
- [x] **Operator sign-off — answers to 15 open questions, plan + checklist approved**

## Phase 1 — Expert panel + design + decision records ⚠

- [x] Convene deep 8-expert panel per build prompt
- [x] Surface conflicts, do not silently resolve
- [x] Decision: Pex transport — HTTP/SSE inbound, plain HTTPS POST outbound, no WS/gRPC (PHASE-1-DESIGN §3.9)
- [x] Decision: token encryption-at-rest — reuse `crypto-util.ts` AES-256-GCM (ADR-0003)
- [x] Decision: pairing — Connection + Channel pair, UI-collapsed (ADR-0003 §pairing model, ADR-0005)
- [x] Decision: libgmessages version pin — git tag, monthly cadence, 5% canary 24h (PHASE-1-DESIGN §3.6)
- [x] Decision: protocol-drift failure mode — flow-heartbeat + decode-error counter primary, copy locked (ADR-0004 + ADR-0005)
- [x] Decision: connector identity — Google Messages / `gmessages` / messaging / Wikimedia logo (PHASE-1-DESIGN §3.7)
- [x] Decision: Plexo vs Levio surface split — Plexo ships baseline viewer + pairing, Levio enriched (ADR-0005)
- [x] Decision: generic Channel viewer scope — thread list + message view + send composer (ADR-0005)
- [x] Decision: Pex Channel subscription contract — host-side REST + SSE, Pex stays at 0.4.0 (ADR-0002)
- [x] Decision: Inngest installed in Plexo, silent + setup-installable (ADR-0006)
- [x] Decision: schema namespace `pgSchema('plexo_gmessages')` (ADR-0003)
- [x] Decision: sidecar tenancy — single-process multi-tenant with Yara's three invariants (ADR-0004)
- [x] Output `PLEXO-GMESSAGES-PHASE-1-DESIGN.md`
- [x] ADRs 0002–0006 written
- [x] **Operator sign-off — Go runtime ✓, Pex stays at 0.4.0 ✓, token storage via crypto-util ✓, schema namespace plexo_gmessages ✓, Inngest install ✓**

## Phase 2 — Pex contract + schema migration ⚠

- [x] Drizzle migration: extend `channelTypeEnum` with `gmessages`
- [x] Drizzle migration: extend `tasks.source` enum with `gmessages`
- [x] Drizzle migration: extend `authTypeEnum` with `paired_session`
- [x] Drizzle migration: `pgSchema('plexo_gmessages')` + `paired_sessions` + `message_dedupe` + `rcs_feature_cache`
- [x] `connectionsRegistry` seed row for `gmessages`
- [x] Pex Channel envelope types (`ChannelMessage`, `ChannelThread`, `ChannelDescriptor`, `ChannelEvent`)
- [x] Pex Connection type for paired session (`PairedConnectionDescriptor`, `ConnectionState`)
- [x] Pex Channel subscription contract — `/api/plexo/channels/*` host endpoints (ADR-0002)
- [x] TS types exported in `packages/sdk` (`PEX_VERSION`, all channel envelopes)
- [x] `@plexo/sdk` runtime client `createChannelClient` (resolves Levio ADR-03's `plexo.channel.dispatch()` open question)
- [x] HMAC service auth middleware (`apps/api/src/middleware/hmac-service.ts`)
- [x] Connector inbound route `/api/plexo/channels/gmessages/{inbound,state,heartbeat}`
- [x] Inngest dep + compose service + install.sh keys + .env.example
- [x] Go-consumable type representation (deferred to Phase 3 — `apps/gmessages/internal/pex/` hand-mirror with CI compat test)
- [x] Output `PLEXO-GMESSAGES-PHASE-2-CONTRACT.md`
- [ ] **Operator confirms migration ran clean on dev DB** (verified §6 of contract doc; awaiting sign-off)

## Phase 3 — Go connector skeleton

- [x] New dir `apps/gmessages/` with cmd/internal/testdata/docker layout
- [x] `go.mod` declared (Go 1.23) — libgmessages pin deferred to Phase 4 when first imported
- [x] Pex client: outbound HMAC POST to `/api/plexo/channels/gmessages/{inbound,state,heartbeat}`
- [x] Pex types mirror of `@plexo/sdk` (ChannelMessage / ChannelEvent / ConnectionState / Heartbeat)
- [x] CI compat test round-tripping TS canonical fixture (`internal/pex/types_compat_test.go`)
- [x] `/health` endpoint + binary `-healthcheck` self-probe for distroless container
- [x] Layered liveness scaffold: process probe live, library probe stub (Phase 4), flow heartbeat live
- [x] Per-session goroutine pool with HKDF key derivation + panic isolation + key zeroing (ADR-0004 invariants 1-3)
- [x] Compile-time-redacted log types (`Secret`, `SessionBlob` in `internal/log`)
- [x] Env-only config; no `.env` direct read
- [x] `make dev` / `make build` / `make test` / `make docker-build` targets
- [x] Multi-stage Dockerfile (`golang:1.23-alpine` → `distroless/static-debian12:nonroot`)
- [x] Compose service `gmessages` with healthcheck wired
- [x] Synthetic-boot smoke test verified: HMAC + JSON + route mount all confirmed (400 on empty payload as expected)
- [x] Telemetry shim deferred to Phase 6 ops (Pushd audit ingest)
- [x] Output `PLEXO-GMESSAGES-PHASE-3-SKELETON.md`

## Phase 4 — Pairing UI + Connection lifecycle + generic Channel viewer

### Phase 4a — pairing vertical slice ✅ complete

- [x] libgm spike: package is `pkg/libgm` (not `libgmessages`); v0.2604.0 pinned; Go bumped 1.23 → 1.25
- [x] `apps/gmessages/internal/pair/manager.go` + libgm.Client + PairCallback wiring
- [x] `apps/gmessages/internal/pair/http.go` — `/pair/start`, `/pair/status`, `/pair/discard`
- [x] `apps/gmessages/internal/httpauth/hmac.go` — sidecar HMAC verification (mirrors apps/api/src/middleware/hmac-service.ts)
- [x] `apps/api/src/lib/gmessages-sidecar.ts` — Node-side HMAC client to sidecar
- [x] `apps/api/src/routes/connections-gmessages.ts` — `/pair-start` + `/pair-status` Better Auth-gated
- [x] Mount at `/api/v1/connections/gmessages` in `apps/api/src/index.ts`
- [x] Pairing UI: consent (locked copy) → starting → waiting → linked → expired/errored states
- [x] Schema writes per ADR-0003: installed_connections + channels + paired_sessions in one transaction
- [x] Audit + trackEvent: `gmessages.pair.started` + `gmessages.pair.linked`
- [x] Compose: `GMESSAGES_SIDECAR_URL` env wired to api service
- [x] All typechecks + go vet + go test clean
- [x] Output `PLEXO-GMESSAGES-PHASE-4-PAIRING.md`

### Phase 4b — session lifecycle ✅ complete

- [x] `apps/gmessages/internal/session/handler.go` — `LibgmHandler` hydrates from sess.AuthBlob, Connect → block → Disconnect
- [x] `apps/gmessages/internal/cryptosvc/cryptosvc.go` — Go mirror of `apps/api/src/crypto.ts` AES-256-GCM (round-trip test green)
- [x] On sidecar boot: GET `/api/plexo/channels/gmessages/restore-list`, decrypt, `manager.Start` for each (ADR-0004 §"Restart semantics")
- [x] Manager.Start signature carries authBlob; Session struct carries AuthBlob + Counters
- [x] Wire `liveness.HeartbeatLoop` per active session in `manager.runSession` (60s cadence)
- [x] Inngest function: `gmessages.session.refresh` (cron `*/15 * * * *`, fan-out via step.sendEvent)
- [x] Inngest function: `gmessages.stale-session.monitor` (cron `*/5 * * * *`, flips state='errored' at 24h)
- [x] Mount `/api/inngest` serve handler in apps/api/src/index.ts
- [x] State transitions: post `active` on Connect, `expired` on Connect failure, `errored` on stale (transitions to `refreshing` + `revoked` deferred to Phase 5)

#### Phase 4b open items (carry forward)

- [x] `qrcode.react` dep approved → swap UI QR placeholder for `<QRCodeSVG />` (master plan §authorization-gates #8 — closed 2026-05-06)
- [ ] Live phone-scan operator-witnessed dev test
- [x] Sidecar `POST /sessions/:id/refresh` receiver consuming `gmessages.session.refresh-requested` events (shipped Phase 5)
- [x] libgm message-event normalization in `LibgmHandler.dispatchEvent` (shipped Phase 5)

### Phase 4c — generic Channel viewer ✅ complete

- [x] `app/channels` — list of paired Channels (channel-type-agnostic; offline pill per row)
- [x] `app/channels/[channelId]` — thread list page (offline banner + locked empty-state copy; aggregate query deferred to Phase 5)
- [x] `app/channels/[channelId]/[threadId]` — message view + plain-text send composer (Enter-to-send, optimistic pending flag)
- [x] Phone-offline banner sourced from `paired_sessions.state` (extracted as shared `_components/phone-offline-banner.tsx`)
- [x] Empty states ("No messages yet." locked copy; pair-flow deep-link from list page)
- [x] Connections list page: per-channel "Open in Plexo viewer" CTA in `connection-detail.tsx` (resolves C4)
- [x] Backend: viewer endpoints under `/api/v1/channels/:id*` (Better Auth-gated; threads/messages skeletons; POST 202 echo)
- [x] List endpoint `GET /api/v1/channels` now attaches `state` per row via paired-session join

#### Phase 4c open items (carry forward)

- [x] `qrcode.react` dep approved (master plan §authorization-gates #8 — closed 2026-05-06)
- [ ] Live phone-scan + offline-banner-against-expired-session operator-witnessed dev test (deferred to Phase 6 ops smoke — staging pass scheduled)

## Phase 5 — Message normalization + ingestion ✅ complete

- [x] Inbound: libgmessages event → connector normalization (`*libgm.WrappedMessage` type-switch in `LibgmHandler.dispatchEvent`)
- [x] Inbound: normalized event → Pex event → Plexo Core ingestion (`POST /api/plexo/channels/gmessages/inbound` real ingest)
- [x] Inbound: standard channel storage write (`conversations` row per inbound, `source='gmessages'`)
- [x] Inbound: queryable through standard channel read API — `GET /api/v1/channels/:id/threads` + `/threads/:threadId/messages` populated (channel-type-agnostic; reused by Phase L)
- [x] Outbound: Plexo Core → Pex command → connector → libgmessages send (`POST /sessions/:id/send` HMAC; `client.SendMessage` on owning goroutine via Cmd channel)
- [x] Outbound: idempotency keyed on message ID (libgm `TmpID` = idempotencyKey; ack via echo `*libgm.WrappedMessage`)
- [x] Restart-mid-stream dedupe strategy (`plexo_gmessages.message_dedupe ON CONFLICT DO NOTHING` PK on `(workspace_id, gmessages_msg_id)`)
- [x] State-machine completion (`*events.GaiaLoggedOut` → `revoked`; `refreshing` during refresh)
- [x] Inngest `gmessages.session.refresh-requested` receiver (HMAC-POSTs sidecar `/sessions/:id/refresh`)
- [x] Output `PLEXO-GMESSAGES-PHASE-5-INGEST.md`

#### Phase 5 deferred to Phase 6 ops (carry forward)

- [ ] Attachments: fetch + decrypt (AES-CTR/GCM via libgm helpers) + re-upload to Plexo attachment store (envelope carries refs; viewer renders file pills until Phase 6+)
- [ ] Attachments: forward-compatible with Fonto stubs
- [ ] Read receipts bidirectional where libgmessages supports
- [ ] Typing indicators bidirectional where libgmessages supports
- [ ] Hookup to existing `reflectAndPromote` memory pipeline (inbound rows land in `conversations`; classifier path not yet hooked)
- [ ] SSE pub/sub fan-out (`/api/plexo/channels/:channelId/events` still keepalive stub)
- [ ] Outbound delivery correlation (`pending: true` flip via TmpID echo)
- [ ] Unread-badge tracking
- [ ] Sender-name persistence (envelope `senderId` logged, not stored)
- [ ] RCS-specific features (rich cards, suggested replies) — per Phase 1 in-scope/deferred
- [ ] Test suite covering inbound, outbound, attachments, dedupe (live phone-scan smoke = Phase 6 ops)

## Phase 6 — Operations ⚠

- [x] Deploy manifest — existing `gmessages:` compose service (docker-compose.yml:254-283); audited prod-shaped without override (PHASE-6-OPS.md §2)
- [x] Platform-compose config (joeybuilt VPS) — env-vars surface table in PHASE-6-OPS.md §3; `.env.full.example` Google Messages section
- [x] Health probes wired to telemetry — process (`/health` + `-healthcheck`) + flow (`HeartbeatLoop` 60s) + state (Inngest stale-session monitor `*/5 * * * *`); see PHASE-6-OPS.md §4
- [x] Stale-session monitor cron (shipped Phase 4b; verified registered in `inngestFunctions`)
- [x] Runbook: session expired (`apps/gmessages/RUNBOOK.md` §1)
- [x] Runbook: libgmessages version bump (RUNBOOK.md §2 — monthly cadence + 5% canary 24h)
- [x] Runbook: Google protocol drift detected (RUNBOOK.md §3)
- [x] Runbook: connector restart loop (RUNBOOK.md §4)
- [x] README in connector dir (`apps/gmessages/README.md`)
- [x] Output `PLEXO-GMESSAGES-PHASE-6-OPS.md` (full ops doc consolidating runbook + manifests + ship-gate checklist + staging-smoke runbook §7.3 + Phase L handoff)
- [x] `qrcode.react` dep approved + wired (master plan §authorization-gates #8 — closed 2026-05-06; pair page renders `<QRCodeSVG />`)
- [x] Phase 6 hardening pass (autonomous, panel-driven 2026-05-06): startup HMAC self-check (Yara P0); cryptosvc.TestDecrypt_BootRestoreFailureModes 8-case (Jin P0); migration 0108/0109 audit clean (Mira P0); sidecar bumped to `0.0.5-phase-6-ops`
- [x] Ship-gate verification battery: sidecar `go vet`/`go build`/`go test -count=1 ./...` green; api typecheck zero new errors; queue + web typecheck clean; `docker compose build gmessages` produces `plexo-gmessages:latest`
- [x] Hub build added to verification battery (regression-driven 2026-05-06; PHASE-6-OPS §10)
- [x] Push target + deploy target confirmed (joeybuilt-official/plexo:main → joeybuilt VPS via auto-deploy daemon; gmessages sidecar in platform compose at `/srv/platform/infra/`)
- [x] First prod deploy executed 2026-05-06 22:49 UTC (commits `bb9cd2cc` Phases 2-6 + `9396b6bf` hub build fix; sidecar `0.0.5-phase-6-ops` healthy with HMAC self-check passing; migrations 0117 applied via direct psql per PHASE-6-OPS §3.3 drizzle MAX(created_at) recovery)
- [ ] **Operator sign-off — witnessed phone-pair smoke per PHASE-6-OPS §7.3** (pair → send → receive → force-expire/reconnect → restart sidecar/boot-restore). Master plan §authorization-gates #6 closes on green pass.

#### Phase 6 ops follow-ups (post-deploy, not gate-blocking)

- [ ] Inngest service in platform compose (gmessages crons `*/15` refresh + `*/5` stale-monitor inactive in prod until added) — paste-ready workflow at PHASE-6-OPS §3.6 (env vars + service block + plexo-api wiring); operator approval required for new env vars + new service
- [x] Backfill `drizzle.__drizzle_migrations.created_at` (applied 2026-05-06; 118 rows updated from journal `when`; `/migrate.sh` now exits clean for current state; new caveat about future-dated 0112–0117 entries documented in PHASE-6-OPS §3.3 — drizzle-kit-generated `when=Date.now()` will be < MAX until 2026-05-20)
- [ ] Persist the platform compose `plexo-gmessages` service definition in the platform repo (currently inline-edited only; backup at `docker-compose.yml.bak.before-gmessages-2026-05-06` on the VPS) — paste-ready workflow at PHASE-6-OPS §3.5; platform IS a real git repo (`joeybuilt-official/platform:main`); auto-deploy daemon redeploys only `caddy` on platform pushes so no rebuild churn; operator approval required for the push

## Phase L — Levio integration ⚠

- [ ] Verify Levio's in-flight Phase 7 closeout (`/home/user/dev/joeybuilt/levio/next-session.txt`) is shipped and stable
- [ ] New "Messages" surface in Levio IA per Phase 1 decision (peer to `email/`?)
- [ ] Levio subscribes to user's Google Messages Channel via Pex Channel subscription contract
- [ ] Threaded conversation list (Levio-enriched)
- [ ] Message view (Levio-enriched, attachment rendering)
- [ ] Send composer wired through Pex Channel send contract
- [ ] "Connect Google Messages" CTA in Levio onboarding + settings
- [ ] CTA deep-links to Plexo pairing flow; returns to Levio on completion
- [ ] "Phone offline" status sourced from Plexo Core (no Levio-local cache)
- [ ] Pex agent call: smart replies endpoint
- [ ] Pex agent call: prioritization endpoint
- [ ] Pex agent call: summarization endpoint
- [ ] Pex agent call: unified search across email + SMS/RCS
- [ ] Notification integration via Levio's existing patterns + ADR-10 dedup
- [ ] Per-channel mute, per-thread mute (state in Plexo Core)
- [ ] Levio ship gate: tests, typecheck, build clean
- [ ] Levio deploy target confirmed
- [ ] Output `PLEXO-GMESSAGES-PHASE-L-LEVIO.md`
- [ ] **Operator sign-off — first Levio deploy with messaging surface**

## Phase O1 — Observability: Logging Completeness + External Error Sink

- [ ] **Operator sign-off: approve Sentry as external service + provide SENTRY_DSN env var**
- [ ] `apps/api/src/routes/code.ts`: add logger import; replace 6 silent catch blocks with `logger.warn`/`logger.error`
- [ ] `apps/api/src/routes/sse.ts`: add logger import; wire the 1 silent catch
- [ ] Annotate intentional-silence catches in sse-emitter.ts, extensions.ts (comment explaining why)
- [ ] Install `@sentry/node` in apps/api; initialize in `apps/api/src/index.ts` before routes
- [ ] Sentry `beforeSend`: scrub fields matching `/notes/i` from breadcrumbs
- [ ] Sentry `beforeSend`: filter `IGNORE_ERRORS` list (port from trackError)
- [ ] Log startup warning if `SENTRY_DSN` is undefined
- [ ] Install `@sentry/nextjs` in apps/web
- [ ] Wire `apps/web/src/instrumentation.ts` to Sentry Next.js SDK
- [ ] Wire `apps/web/src/global-error.tsx` to call `Sentry.captureException`
- [ ] Typecheck clean (api + web)
- [ ] Commit + push + deploy
- [ ] Operator smoke: trigger a test error from API + web; verify Sentry receives both
