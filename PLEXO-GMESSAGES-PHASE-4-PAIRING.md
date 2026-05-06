# PLEXO Google Messages connector — Phase 4 pairing

**Status:** Phase 4a + 4b + 4c complete. Phase 4 closed; Phase 5 (message normalization + ingestion) is the next slice.
**Date:** 2026-05-06 (4c); 2026-05-05 (4a + 4b)
**Inputs:** `PLEXO-GMESSAGES-PHASE-1-DESIGN.md`, `PLEXO-GMESSAGES-PHASE-2-CONTRACT.md`, `PLEXO-GMESSAGES-PHASE-3-SKELETON.md`, ADRs 0004 + 0005 + 0006.

Phase 4 was sliced via expert panel into three sessions per the operator-approved "spike + vertical slice" default. Phase 4a delivers the pairing flow end-to-end (consent UI → API → sidecar → libgm.StartLogin → user scans → AuthData persisted encrypted) so the operator has a clickable artifact validating the contracts before 4b/4c bolt on the rest.

---

## 1. libgmessages spike (one-way door, executed)

The Phase 1 design doc named the upstream package `go.mau.fi/mautrix-gmessages/libgmessages`. The actual import path is **`go.mau.fi/mautrix-gmessages/pkg/libgm`** — the package directory is `pkg/libgm`, not `libgmessages`. References to "libgmessages" elsewhere in the build prompt and ADRs are aliases for this package.

**Pinned tag:** `v0.2604.0`. CalVer (year 2026, month 04). Newest as of pin date.

**Required Go version:** 1.25 (libgm v0.2604.0 requires `go ≥ 1.25.0`). Phase 3 documented Go 1.23 in the Dockerfile + go.mod; Phase 4a bumped both in lockstep with the libgm pin. The bump cadence runbook (Phase 6 ops) should require Go-version checks alongside libgm bumps.

**Verified public API (smoke-built in Docker):**

```go
auth   := libgm.NewAuthData()                                // bare; populated by pairing
client := libgm.NewClient(auth, nil, zerolog.Logger)         // PushKeys nil-safe (we do not register push)
qrURL, err := client.StartLogin()                            // returns scannable URL string
client.PairCallback.Store(&func(*gmproto.PairedData){...})   // fires on phone scan; AuthData fully populated by then
```

`StartLogin` internally spawns the long-poll goroutine, so we do not call `Connect()` during pairing — `Connect()` is the post-pair restart path (Phase 4b). After the callback fires, `client.AuthData` is the full session blob (cookies + tachyon token + browser/mobile identity + crypto helpers); JSON-marshaling it via standard struct tags round-trips cleanly.

**No CGo:** zerolog + protobuf + stdlib only. Distroless static base holds.

**Transitive licenses:** AGPL-3 carries forward (already accepted; Plexo's `apps/gmessages/` ships the SPDX header). New transitive deps: `github.com/google/uuid`, `github.com/rs/zerolog`, `go.mau.fi/util`, `golang.org/x/crypto`, `golang.org/x/exp`, `google.golang.org/protobuf`, `golang.org/x/sys`, `github.com/mattn/go-{colorable,isatty}`. All MIT/BSD/Apache-2.

---

## 2. Pairing flow surfaces

Three layers wired end-to-end in 4a. Each layer is HMAC-bounded against the next; user input never sees the libgm session blob.

```
[Web UI: app/connections/gmessages/pair]
   ↓ fetch /api/v1/connections/gmessages/pair-start  (Better Auth cookie)
[apps/api: connections-gmessages.ts]
   ↓ HMAC POST /pair/start  (PLEXO_SERVICE_KEY, X-App-Id: plexo-api)
[apps/gmessages: cmd/gmessages + internal/pair]
   ↓ libgm.NewClient + Client.StartLogin
[Google Messages servers]
   ← QR URL (scannable string)
   ←━━━━━━━━━ user scans on phone ━━━━━━━━━━
   ← PairCallback fires with PairedData; Manager snapshots client.AuthData → blob

[Web UI polls every 2s]
   ↓ GET /api/v1/connections/gmessages/pair-status?id=…&workspaceId=…
[apps/api]
   ↓ HMAC GET /pair/status?id=…
[apps/gmessages] returns { state, authBlob (base64) when linked }
[apps/api] on linked:
   - encrypt(authBlob, workspaceId) via apps/api/src/crypto.ts AES-256-GCM
   - INSERT installed_connections (encrypted credentials, label="phone-{ts}")
   - INSERT channels (type='gmessages', config={connectionId})
   - INSERT plexo_gmessages.paired_sessions (state='paired')
   - HMAC POST /pair/discard (best-effort)
   - return { state: 'linked', connectionId, channelId, pairedSessionId }
```

### 2.1 Sidecar layer

| File | Purpose |
|---|---|
| `apps/gmessages/internal/pair/manager.go` | Pair pool: per-pairingId libgm.Client + PairCallback wiring + 5-min TTL expiry watcher |
| `apps/gmessages/internal/pair/http.go` | `/pair/start`, `/pair/status`, `/pair/discard` HTTP handlers |
| `apps/gmessages/internal/httpauth/hmac.go` | Mirror of `apps/api/src/middleware/hmac-service.ts`. Reads body bytes, verifies sha256 against `PLEXO_SERVICE_KEY`, 5-min timestamp skew |
| `apps/gmessages/cmd/gmessages/main.go` | Wires `pair.NewManager` + mounts `/pair/` routes behind `httpauth.RequireHMAC`; bumps version to `0.0.2-phase-4a-pair` |

ADR-0004 invariants 1-3 inherit from Phase 3; the pair pool's libgm.Clients are scoped to a single goroutine (the pair goroutine) and torn down via `client.Disconnect()` on Discard.

### 2.2 API layer

| File | Purpose |
|---|---|
| `apps/api/src/lib/gmessages-sidecar.ts` | HMAC client: `sidecarPairStart`, `sidecarPairStatus`, `sidecarPairDiscard`. Uses same `PLEXO_SERVICE_KEY` shared secret |
| `apps/api/src/routes/connections-gmessages.ts` | `/pair-start` + `/pair-status` Better Auth-gated routes |
| `apps/api/src/index.ts` | Mount at `v1.use('/connections/gmessages', connectionsGmessagesRouter)` |

ADR-0005 §"Consequences" boundary honored: `/api/v1/connections/gmessages/*` is the **pairing-lifecycle** surface, distinct from `/api/plexo/channels/gmessages/*` (the connector-facing inbound contract from Phase 2). Different auth (Better Auth vs HMAC), different audience (UI vs sidecar), different ownership (user lifecycle vs message ingestion).

Audit log emits `gmessages.pair.started` and `gmessages.pair.linked`; trackEvent fires the same. Phase 6 will wire stale-session monitor events.

### 2.3 UI layer

`apps/web/src/app/app/connections/gmessages/pair/page.tsx` — single client component with state machine `consent | starting | waiting | linked | expired | errored`.

Copy is locked per ADR-0005 §"Copy lock". The consent screen text is the legal anchor; do not improvise.

**Phase 4a UI scope notes:**
- QR rendering uses a textual fallback (`<pre>` showing the URL). The `qrcode.react` dep is the natural choice but adding it requires operator sign-off per master plan §authorization-gates #8 ("Any dependency add beyond `libgmessages` and its transitive deps"). Phase 4b swaps in `<QRCodeSVG value={url} />` once approved. The pairing URL is end-to-end testable without the QR scan happening from the browser — paste into any QR encoder for now.
- `?return=levio` deep-link redirect target is `/app/messages` (the Levio surface, owned by Phase L).

---

## 3. Schema writes

Phase 4a writes occur inside one `db.transaction`:

```
INSERT installed_connections   (workspace_id, registry_id='gmessages',
                                credentials={encrypted: …}, label='phone-…',
                                status='active', last_verified_at=now)
INSERT channels                (workspace_id, type='gmessages',
                                config={connectionId: <fk>}, enabled=true)
INSERT plexo_gmessages.paired_sessions  (workspace_id, installed_connection_id,
                                channel_id, state='paired',
                                pair_started_at=now, paired_at=now)
```

Channel + Connection split per ADR-0003 (resolves Phase 1 cross-conflict C4): two database entities, the UI collapses to one row in the connections list. The `label='phone-{timestamp-base36}'` value scopes the unique index `(workspace_id, registry_id, label)` so the same workspace can pair multiple phones.

Decryption side (Phase 4b): `apps/api/src/crypto.ts::decrypt(encrypted, workspaceId)` returns the base64 `authBlob`; base64-decode → JSON-unmarshal → libgm.AuthData → `libgm.NewClient(authData, nil, logger)` → `client.Connect()`.

---

## 4. Compose + env

| Var | Where | Default |
|---|---|---|
| `GMESSAGES_SIDECAR_URL` | api service (NEW in 4a) | `http://gmessages:3010` |
| `PLEXO_SERVICE_KEY` | both api + gmessages | required (set by `scripts/install.sh`) |
| `ENCRYPTION_SECRET` | api (existing) + gmessages master | required |
| `GMESSAGES_MASTER_KEY` | gmessages (falls back to `ENCRYPTION_SECRET`) | optional |

No new docker-compose services in 4a (the `gmessages` service was wired in Phase 3). Only the api environment variable was added.

---

## 5. Verification

| Surface | Method |
|---|---|
| Sidecar build | `docker run … golang:1.25-alpine sh -c "go build ./... && go test ./..."` — clean |
| Sidecar vet | `go vet ./...` — clean |
| API typecheck | `pnpm -F @plexo/api typecheck` — clean |
| Web typecheck | `pnpm -F @plexo/web typecheck` — clean |
| Existing pex/session tests | pass (carryover from Phase 3) |

**Not verified in 4a:**
- Live QR-scan against a real phone (requires the operator scanning a phone; Phase 4b operator-witnessed dev test).
- libgm session restoration after sidecar restart (Phase 4b `session.Manager.Start` from encrypted blob).
- Inbound message normalization through the existing `/inbound` route (Phase 5).

---

## 6. Deviations from Phase 1 design + ADR-0005

| Deviation | Reason |
|---|---|
| Package name `libgm` (not `libgmessages`) | Upstream packages it under `pkg/libgm`. Doc-only correction; no code impact. |
| Go 1.23 → 1.25 | Required by libgm v0.2604.0. Bump cadence aligned with libgm pin policy. |
| QR returned to UI as raw URL string, not "PNG data URL" (ADR-0005 §QR scan screen) | UI-side rendering with `qrcode.react` is cheaper + keeps the protocol payload in the browser without a server-side raster step. ADR-0005 will be amended in 4b when the dep lands. Pending operator OK on the dep. |
| Pairing endpoints under `/api/v1/connections/gmessages/` (ADR-0005 says `/api/connections/`) | Plexo's actual mount path is `/api/v1/`; ADR-0005's `/api/connections/` was shorthand. Same surface. |

---

## 7. Phase 4 build log

### Phase 4b ✅ complete (this session)

- (b cont.) `apps/gmessages/internal/session/handler.go` — `LibgmHandler` hydrates `libgm.Client` from `sess.AuthBlob`, calls `Connect()`, registers an event handler that bumps `sess.Counters` (MarkInbound / MarkDecodeError), posts `state='active'` on connect, blocks until ctx, calls `Disconnect()` on exit. Phase 5 type-switches the inbound message events for normalization.
- (g) `apps/gmessages/internal/cryptosvc/cryptosvc.go` mirrors `apps/api/src/crypto.ts` AES-256-GCM (HMAC-SHA256-derived workspace key). On boot `cmd/gmessages/main.go::runBootRestore` GETs `/api/plexo/channels/gmessages/restore-list`, decrypts each entry locally, calls `mgr.Start`. Failures post `state='errored'`. Round-trip test in `cryptosvc_test.go`.
- (h) `internal/session/Manager.runSession` spawns `liveness.HeartbeatLoop(ctx, pexClient, sess.ID, sess.Counters, 60s)` alongside the Handler. Counters live on `Session`; heartbeat goroutine and handler share the same ctx.
- (f) `packages/queue/src/inngest/functions/gmessages-session-refresh.ts` (cron `*/15 * * * *`) + `gmessages-stale-session-monitor.ts` (cron `*/5 * * * *`). Stale-session monitor scans `paired_sessions` for `last_inbound_at < now - 24h` (env-tunable), flips state to `errored`, emits `gmessages.session.stale-detected` event. Session-refresh emits `gmessages.session.refresh-requested` events fan-out. Inngest serve handler mounted at `/api/inngest`. The receiver-side sidecar refresh endpoint is left as Phase 5 — `LibgmHandler` doesn't yet expose a per-session refresh hook (see §"Open seams" below).

### Phase 4c ✅ complete (2026-05-06)

- (e) Generic Channel viewer per ADR-0005 §"Generic Channel viewer (Plexo proper)":
  - `apps/web/src/app/app/channels/page.tsx` — channel list. Channel-type-agnostic (`type` is shown as a badge so future Signal/WhatsApp connectors render in the same surface). Each row gets an Offline pill when joined `paired_sessions.state IN ('expired','revoked','errored')`.
  - `apps/web/src/app/app/channels/[channelId]/page.tsx` — thread list with phone-offline banner at top. Phase 4c renders the empty-state shell (locked copy "No messages yet."); Phase 5 lands the aggregate query.
  - `apps/web/src/app/app/channels/[channelId]/[threadId]/page.tsx` — message view + plain-text composer (placeholder "Type a message"; markdown not parsed). Locked Enter-to-send / Shift-Enter-newline. Optimistic `pending: true` flag while POST is in flight. No reactions UI, no edit indicators (per ADR-0005 §"Out of v1 scope").
  - `apps/web/src/app/app/channels/_components/phone-offline-banner.tsx` — single shared offline banner, ADR-0005 §"Copy lock" verbatim, Reconnect link deep-links to `/app/connections/gmessages/pair`.
- (f) Connections list collapse (resolves C4): `apps/web/src/app/app/connections/_components/connection-detail.tsx` — per-channel "Open in Plexo viewer" deep-link added inside the existing `linkedChannels` block. "Open in Levio" CTA deferred to Phase L per scope.
- (g) Backend: Better Auth-gated viewer endpoints added to `apps/api/src/routes/channels.ts`:
  - `GET /api/v1/channels/:id` — single channel + most-recent `state` from `paired_sessions`. Channel-type-agnostic; `state` is `null` for non-paired channel types (telegram, slack, etc.).
  - `GET /api/v1/channels/:id/threads` — empty-state shell (`{ threads: [] }`).
  - `GET /api/v1/channels/:id/threads/:threadId/messages` — empty-state shell.
  - `POST /api/v1/channels/:id/threads/:threadId/messages` — 202 echo skeleton. Phase 5 plumbs actual outbound dispatch through the connector.
  - The existing list endpoint `GET /api/v1/channels` was extended to attach `state` per row via a per-workspace paired-session join (latest by `state_changed_at`). Backward-compatible — existing consumers gain an optional field.
- Boundary preserved per ADR-0005 §"Consequences": these viewer routes live under `/api/v1/` (Better Auth, host-side) and are distinct from `/api/plexo/channels/*` (HMAC, sibling-app-facing).

### Open seams for Phase 5

- **Sidecar-side refresh receiver.** `gmessages.session.refresh-requested` events are emitted by Inngest but not yet consumed. Phase 5 adds a sidecar HTTP endpoint `POST /sessions/:id/refresh` (HMAC-authed) that calls `libgm.Client.RefreshPhoneRelay()` on the named session's running goroutine. Requires plumbing a refresh channel through `Session` + `Manager.Range`.
- **Inbound message normalization.** `LibgmHandler.dispatchEvent` currently only counts inbound events. Phase 5 type-switches the message-bearing events from `pkg/libgm/events` (when added upstream — current `events/` package only exposes ready/qr/useralert types) and posts normalized `pex.ChannelInbound` envelopes. The actual message events come through libgm via different protobuf paths inspected in `pkg/libgm/event_handler.go`.
- **State-machine completeness.** Currently the sidecar posts `active` on Connect, `expired` on Connect failure, and Inngest posts `errored` on stale-out. Transitions to `refreshing` (during refresh) and `revoked` (on `events.GaiaLoggedOut`) are stubbed — Phase 5 wires them in `dispatchEvent`.

---

## 8. Phase 4b additions — file map

| File | Change | Layer |
|---|---|---|
| `apps/gmessages/internal/session/handler.go` | NEW — `LibgmHandler` real handler | sidecar |
| `apps/gmessages/internal/session/manager.go` | Session: +AuthBlob + Counters; Manager: +pexClient; runSession spawns HeartbeatLoop | sidecar |
| `apps/gmessages/internal/session/manager_test.go` | Updated NewManager + Start signatures | sidecar |
| `apps/gmessages/internal/cryptosvc/cryptosvc.go` | NEW — Go mirror of `apps/api/src/crypto.ts` | sidecar |
| `apps/gmessages/internal/cryptosvc/cryptosvc_test.go` | NEW — Node→Go round-trip | sidecar |
| `apps/gmessages/internal/pex/client.go` | +`FetchRestoreList` + `get` helper | sidecar |
| `apps/gmessages/cmd/gmessages/main.go` | `runBootRestore` + `LibgmHandler` wiring; version `0.0.3-phase-4b-lifecycle` | sidecar |
| `apps/api/src/routes/channels-gmessages.ts` | +GET `/restore-list` (joined paired_sessions ⨝ installed_connections) | api |
| `apps/api/src/index.ts` | +mount `/api/inngest` (Inngest serve handler) | api |
| `packages/queue/src/inngest/functions/gmessages-session-refresh.ts` | NEW — cron `*/15 * * * *` | queue |
| `packages/queue/src/inngest/functions/gmessages-stale-session-monitor.ts` | NEW — cron `*/5 * * * *` | queue |
| `packages/queue/src/inngest/express.ts` | NEW — re-export `serve()` so api avoids direct inngest dep | queue |
| `packages/queue/src/inngest/index.ts` | +`inngestFunctions` array | queue |
| `packages/queue/package.json` | +`./inngest-express` exports map | queue |

---

## 9. Verification (Phase 4b)

| Surface | Method | Status |
|---|---|---|
| Sidecar build | `docker run … golang:1.25-alpine sh -c "go vet ./... && go build ./... && go test -count=1 ./..."` | ✅ clean |
| `cryptosvc` Node↔Go round-trip | new test in `cryptosvc_test.go` | ✅ pass |
| Queue typecheck | `pnpm -F @plexo/queue typecheck` | ✅ clean |
| API typecheck (Phase 4b code) | `pnpm -F @plexo/api typecheck` filtered to `gmessages*|inngest*` | ✅ clean |

**Pre-existing TS errors (NOT introduced by Phase 4b):**
- `apps/api/src/lib/deepgram.ts` lines 363 + 577 — `Buffer<ArrayBufferLike>` not assignable to `BodyInit`/`BlobPart`. TS 5.7+ + `@types/node` 22+ tightening; surfaced when typecheck cache invalidates.
- `apps/api/src/routes/telegram.ts` line 239 — same `Buffer<ArrayBufferLike>` issue.

These errors are unrelated to gmessages and were present before Phase 4b began (verified via `git stash` round-trip). Per CLAUDE.md §"Don't fix unrelated issues" they are not Phase 4b's responsibility. Operator may want a small parallel chore to fix them since they block any future api-wide typecheck-clean state.

**Not verified in 4b (deliberate):**
- Live phone-scan + restart-restore round-trip.
- Inngest cron firing (requires the Inngest dev server reachable + functions discovered).
- Sidecar→libgm Connect against a real expired session (would need a previously-paired phone).

---

## 10. Phase 4c additions — file map

| File | Change | Layer |
|---|---|---|
| `apps/web/src/app/app/channels/page.tsx` | NEW — channel list | web |
| `apps/web/src/app/app/channels/[channelId]/page.tsx` | NEW — thread list | web |
| `apps/web/src/app/app/channels/[channelId]/[threadId]/page.tsx` | NEW — message view + composer | web |
| `apps/web/src/app/app/channels/_components/phone-offline-banner.tsx` | NEW — shared banner with locked copy | web |
| `apps/web/src/app/app/connections/_components/connection-detail.tsx` | +per-channel "Open in Plexo viewer" deep-link | web |
| `apps/api/src/routes/channels.ts` | +`loadLatestSessionStates` helper; list now attaches `state` per row; +GET `/:id`, +GET `/:id/threads`, +GET `/:id/threads/:threadId/messages`, +POST `/:id/threads/:threadId/messages` (skeleton) | api |

## 11. Verification (Phase 4c)

| Surface | Method | Status |
|---|---|---|
| Web typecheck | `pnpm -F @plexo/web typecheck` | ✅ clean |
| Queue typecheck | `pnpm -F @plexo/queue typecheck` | ✅ clean |
| API typecheck (Phase 4c code) | `pnpm -F @plexo/api typecheck` filtered to `channels.ts` | ✅ clean |

**Pre-existing TS errors (NOT introduced by Phase 4c, carried from Phase 4b):** `apps/api/src/lib/deepgram.ts:363,577` + `apps/api/src/routes/telegram.ts:239` (Buffer/BlobPart, TS 5.7+ tightening). Unrelated to gmessages; skip unless operator asks for a parallel chore.

**Not verified in 4c (deliberate — needs Phase 5 data path or live dev pass):**
- Live thread/message rendering: by design, threads + messages endpoints return empty shells until Phase 5 lands the ingest path.
- Optimistic-send round-trip against a real phone (also Phase 5 — outbound dispatch is the connector's responsibility).
- Phone-offline banner against a session in `expired`/`revoked`/`errored` state (Inngest stale-session monitor flips `errored` after 24h silence; smoke-testable in dev once a paired phone is left disconnected, but not part of 4c's code-only ship).

## 12. Outstanding authorization gates (carry forward)

- **`qrcode.react` dep** (master plan §authorization-gates #8) — the only paint-point dep this work needed. The viewer itself introduced **zero** new deps (lucide icons, useSWR-style fetch with native `fetch`, existing workspace context). Keeping the consolidated ask narrow to one dep approval.

## 13. Self-generating handoff (Phase 5)

> Resume `PLEXO-GMESSAGES` Phase 5 at `/home/dustin/dev/plexo`. Read in order: `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PROGRESS.md`, `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PHASE-4-PAIRING.md`, `/home/dustin/dev/plexo/adr/0002-pex-channel-contract.md` (or whichever ADR documents the Pex Channel contract — confirm in `adr/`), `/home/dustin/dev/plexo/adr/0005-plexo-viewer-and-pairing.md`, `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PHASE-2-CONTRACT.md`, `/home/dustin/dev/plexo/plan.md`, `/home/dustin/dev/plexo/checklist.md`.
>
> State: Phase 4 closed (4a + 4b + 4c). Pairing flow + libgm-backed session.Handler + boot restore + per-session HeartbeatLoop + Inngest crons + Inngest serve handler at `/api/inngest` + generic Channel viewer at `/app/channels/*` + connection-detail "Open in Plexo viewer" CTA. Sidecar at v0.0.3-phase-4b-lifecycle, libgm v0.2604.0, Go 1.25. Viewer endpoints (`GET /api/v1/channels/:id` + threads + messages, `POST` skeleton) live and Better Auth-gated; threads/messages return empty shells per ADR-0005 §"Empty state".
>
> Untested live (carries into Phase 6 ops): phone scan, restore round-trip, cron firing, offline-banner appearance against an expired session.
>
> **Phase 5 scope** is **message normalization + ingestion** (master plan §"Phase 5"). Open seams flagged in §7 of this doc:
>
> 1. **Sidecar refresh receiver.** Add `apps/gmessages/internal/session/refresh_handler.go` (or wire onto `LibgmHandler`): HTTP `POST /sessions/:id/refresh` HMAC-authed, looks up the running session in `Manager`, calls `libgm.Client.RefreshPhoneRelay()`, posts `state='refreshing'` then `state='active'` (or `state='errored'`) on completion. Consumer of `gmessages.session.refresh-requested` Inngest event from Phase 4b.
> 2. **libgm message-event normalization.** `LibgmHandler.dispatchEvent` currently only counts inbound events. Phase 5 type-switches the message-bearing events from `pkg/libgm/events` (and/or `pkg/libgm/event_handler.go` raw protobuf paths — confirm during spike) and posts normalized `pex.ChannelInbound` envelopes via `POST /api/plexo/channels/gmessages/inbound` (the Phase 2 skeleton currently logs + 202s; Phase 5 implements the dedupe + `messages` table write).
> 3. **State-machine completion.** Wire transitions to `refreshing` (during refresh) and `revoked` (on `events.GaiaLoggedOut` or equivalent libgm signal).
> 4. **Plexo Core ingestion.** Plumb the inbound endpoint into the existing `messages` write path + `reflectAndPromote` memory pipeline.
> 5. **Outbound dispatch.** The viewer's POST endpoint (`apps/api/src/routes/channels.ts::channelsRouter.post('/:id/threads/:threadId/messages')`) currently 202-echoes; Phase 5 calls into the sidecar (new HMAC route `POST /sessions/:id/send`) which then drives `libgm.Client.Send*`. Idempotency keyed on the message ID (master plan §Phase 5 exit criteria).
> 6. **Attachments.** Fetch + decrypt (libgm AES-CTR/GCM helpers per audit) + re-upload to the existing Plexo attachment store. Phase 4c viewer renders `MessageRow.attachments` as clickable file pills; Phase 5 swaps thumbnail rendering for image MIME types.
> 7. **`/api/v1/channels/:id/threads` + `/threads/:threadId/messages` GETs.** Project rows from `messages` + join `plexo_gmessages.message_dedupe`. Empty shells in 4c are intentional placeholders — see channels.ts.
> 8. **Restart-mid-stream dedupe.** `message_dedupe (workspace_id, gmessages_msg_id)` PK already exists from Phase 2; the ingest path should `INSERT … ON CONFLICT DO NOTHING` keyed on the canonical Google Messages message ID before writing to `messages`.
>
> Phase 5 **convenes the panel again** before starting (per master plan; Phase 5 is a fresh slice). Open one-way doors to surface: (a) any new Go deps from message-normalization (e.g., `protobuf-go` is already transitive via libgm — check), (b) any new TS-side deps for thumbnail rendering, (c) the still-pending `qrcode.react` (carried from 4a).
>
> Pre-existing TS errors in `apps/api/src/lib/deepgram.ts` + `apps/api/src/routes/telegram.ts` (Buffer/BlobPart) are unrelated to gmessages — skip unless operator asks.
