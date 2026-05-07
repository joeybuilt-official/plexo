# PLEXO Google Messages connector — Phase 5 ingest

**Status:** complete (sidecar + API + Inngest receiver shipped). Live phone round-trip is the Phase 6 ops smoke; code-only ship is closed.
**Date:** 2026-05-06
**Inputs:** `PLEXO-GMESSAGES-PHASE-4-PAIRING.md` (§7 + §13 = open seams), ADR-0002 (Pex transport), ADR-0003 (token encryption + schema), ADR-0004 (sidecar tenancy), ADR-0005 (viewer + pairing), ADR-0006 (Inngest install).

Phase 5 closes the open seams flagged at the end of Phase 4: **inbound libgm message events normalize → Plexo Core ingestion**, **outbound viewer-composed text dispatches through the connector to the phone**, and **the refresh-requested Inngest event has a working consumer**. State-machine completes (revoked transition lands).

---

## 1. Slicing — expert panel positions

Convened in-session before code. Surfaced positions:

- **Mira (Protocol)** — libgm splits message events into typed (`pkg/libgm/events`) and raw protobuf (`pkg/libgm/event_handler.go`). Pin to the typed surface where exposed; bump `decode_error_count` for any unmapped raw event so the layered liveness probe can fire.
- **Avi (DB)** — `plexo_gmessages.message_dedupe (workspace_id, gmessages_msg_id)` is the dedupe authority. INSERT … ON CONFLICT DO NOTHING RETURNING gates the canonical write to `conversations`. Keeps the canonical message store inside Plexo Core (no per-connector message table) per ADR-0003.
- **Yara (Sec)** — outbound dispatch HMAC-validates per-pairedSessionId; refresh + send share the existing `httpauth.RequireHMAC` middleware. No tenant key co-resident in memory across sessions (ADR-0004 invariant 1 preserved — DerivedKey stays per session).
- **Sona (UX)** — viewer GETs project from `conversations` directly; thumbnails + unread badges remain Phase 6+ polish.

Conflicts resolved without operator escalation: none. The frozen contracts (inbound envelope, send body, refresh body) made the slice parallelizable.

---

## 2. Sidecar (`apps/gmessages/`)

### 2.1 Event normalization — `internal/session/handler.go`

`LibgmHandler.dispatchEvent` type-switches:

| libgm event | Action |
|---|---|
| `*libgm.WrappedMessage` | Extract text + threadId + msgId + timestamp via helpers `extractMessageText` / `libgmTimestampToTime`. POST `pex.ChannelInbound` envelope to `/api/plexo/channels/gmessages/inbound`. |
| `*events.GaiaLoggedOut` | Post `state='revoked'` via `PexClient.SendStateChange`. |
| `*events.ClientReady` / `*events.AuthTokenRefreshed` | Log only. |
| `*events.ListenFatalError` / `*events.HTTPError` | Bump `Counters.MarkDecodeError` for layered liveness. |
| Any other | Bump `Counters.MarkInbound` (treats as live activity, no normalization). |

The `*libgm.WrappedMessage` symbol lives in `pkg/libgm/event_handler.go` (libgm exposes message events as a wrapper around `*gmproto.Message` + `IsOld`). Helpers in `handler.go` flatten the protobuf payload to plain text by concatenating `MessageContent.Content` across `MessageInfo[]`.

### 2.2 Outbound + refresh transport — `internal/session/manager.go` + `internal/session/http.go` (NEW)

A per-session command channel pattern preserves ADR-0004 invariant: the libgm.Client is owned by exactly one goroutine (the Handler.Run loop). HTTP handlers serialize work onto the owning goroutine via `Session.Cmds chan Cmd`:

```go
type Cmd struct {
    Kind     CmdKind     // CmdSend | CmdRefresh
    ThreadID string
    Text     string
    IdemKey  string
    Reply    chan CmdResult
}
type CmdResult struct {
    MessageID string
    Err       error
}
```

The Handler's main loop replaces the bare `<-ctx.Done()` with a select between `ctx.Done()` and `<-sess.Cmds`. `handleCmd` executes the libgm call (`client.SendMessage(*gmproto.SendMessageRequest)` or `client.RefreshPhoneRelay()`) on the owning goroutine and `replyAsync` posts the result.

**`POST /sessions/:pairedSessionId/send`** — body `{threadId, text, idempotencyKey?}`; the idempotency key becomes the libgm `TmpID` (libgm correlates the eventual ack-`WrappedMessage` event with the same TmpID). Response `202 {messageId}`. Bounded dispatch timeout (5s) and reply timeout (15s); a stalled session goroutine surfaces as a 503/504 rather than holding the HTTP connection open.

**`POST /sessions/:pairedSessionId/refresh`** — body `{}` (read + discarded so HMAC has a definite body). Calls `client.RefreshPhoneRelay()` on the owning goroutine. Response `202 {state}` where state is `refreshing | active | errored`. On reply timeout the kickoff has already happened — the HTTP handler returns `202 {state:'refreshing'}` and the Handler posts the terminal state via `PexClient.SendStateChange` when the libgm call returns.

### 2.3 Wiring — `cmd/gmessages/main.go`

```go
mux.Handle("/sessions/", httpauth.RequireHMAC(cfg.ServiceKey.Reveal(), manager.Handler()))
```

Bumped sidecar version constant to `0.0.4-phase-5-ingest`. Existing pair routes + `/health` left unchanged.

### 2.4 pex types — `internal/pex/types.go`

Extended `ChannelInbound` with `SenderID string \`json:"senderId,omitempty"\`` + `Attachments []InboundAttachment \`json:"attachments,omitempty"\``. New `InboundAttachment` carries `URL` + `MimeType` + `Filename`. Plexo API ignores unknown fields, so the additive change rolls forward without coordinated deploys.

---

## 3. API (`apps/api/`)

### 3.1 Inbound ingestion — `src/routes/channels-gmessages.ts`

Replaced the Phase 2 stub at `POST /api/plexo/channels/gmessages/inbound` with the real ingest path:

1. Validate envelope (`workspaceId`, `channelId`, `threadId`, `gmessagesMsgId`, `text`, `sentAt`; UUIDs for the IDs; `sentAt` parses).
2. Channel lookup — 404 if missing or `type !== 'gmessages'`.
3. Dedupe via `INSERT INTO plexo_gmessages.message_dedupe … ON CONFLICT DO NOTHING RETURNING workspace_id`. Empty return = duplicate; respond `202 { accepted: true, deduped: true }`.
4. Persist into `conversations`:
   - `id`: `ulid()`
   - `workspaceId`, `source: 'gmessages'`, `status: 'complete'`, `intent: null`, `reply: null`
   - `sessionId`: `'gmessages:' + threadId` — the stable thread key the viewer GET groups by.
   - `message`: text
   - `channelRef`: `{ channel: 'gmessages', channelId, chatId: threadId }`
   - `attachments`: envelope's `attachments[]` mapped `{url, mimeType→type, filename?}` (the conversations schema uses `type` for legacy Telegram compatibility).
   - `createdAt`: parsed `sentAt`.
5. Best-effort `UPDATE channels SET last_message_at = sentAt`. Failure logs only.
6. Respond `202 { accepted: true, deduped: false, conversationId }`.

### 3.2 Viewer GETs — `src/routes/channels.ts`

Phase 4c shipped empty shells. Phase 5 fills them, channel-type-agnostically.

`GET /:id/threads` — selects the most-recent 2000 conversations for the workspace where `source = channel.type` AND `channelRef->>'channelId' = :id`. Folds to one row per `sessionId` (most-recent wins for `lastMessagePreview` + `lastMessageAt`). Derives `threadId` from `channelRef.chatId` (falls back to stripping the `gmessages:` prefix from the sessionId when chatId is absent). `unreadCount: 0` until Phase 6+ tracking lands.

`GET /:id/threads/:threadId/messages` — for gmessages, computes `sessionId = 'gmessages:' + threadId` and selects up to 200 conversations DESC by `createdAt`, reverses to ASC. Emits one or two virtual rows per conversation:
- `direction: 'inbound'` when `message` is non-empty.
- `direction: 'outbound'` when `reply` is non-empty (id suffixed `:out` to keep React keys stable).

This matches the Phase 4c web `MessageRow` shape (`id, direction, text, sentAt, attachments?, senderName?, pending?`) so the viewer pages just light up — no web changes required.

### 3.3 Outbound POST proxy — `src/routes/channels.ts`

The Phase 4c skeleton was a 202 echo. Phase 5:

1. Validate text + workspaceId + channel.
2. For non-`gmessages` channels keep the 202-echo (Phase 6+ owns telegram/slack/etc. outbound).
3. For `gmessages`: pick the most-recent paired_session in state IN (`active`, `paired`, `refreshing`); 409 `SESSION_NOT_LIVE` otherwise.
4. `idempotencyKey = ulid()`; call `sidecarSessionSend(pairedSessionId, threadId, text, idempotencyKey)`. Sidecar HMAC failures → 502 `SIDECAR_SEND_FAILED`.
5. Persist optimistic outbound row (`message: ''`, `reply: text`). Persistence failure logs only — don't fail the user-visible 202.
6. Respond `202 { id, channelId, threadId, direction: 'outbound', text, sentAt, pending: true }`.

The eventual delivery confirmation arrives via the libgm-side echo: when the phone re-emits the just-sent message as a `*libgm.WrappedMessage` event, the inbound path runs, dedupe gates on the canonical `gmessagesMsgId`, and the optimistic outbound row stays put. (Future Phase 6+ correlation could use the TmpID echo to flip `pending: false`; v0 keeps the optimistic row.)

### 3.4 Sidecar HMAC client — `src/lib/gmessages-sidecar.ts`

Two new helpers mirror the existing `sidecarPair*` style:

- `sidecarSessionSend(pairedSessionId, threadId, text, idempotencyKey) → { accepted, messageId? }`
- `sidecarSessionRefresh(pairedSessionId) → void`

Both use the shared `sign(body)` helper for `X-Plexo-Signature` + `X-Plexo-Timestamp` + `X-App-Id: plexo-api`.

---

## 4. Inngest receiver

`packages/queue/src/inngest/functions/gmessages-session-refresh-receiver.ts` (NEW).

Trigger: event `gmessages.session.refresh-requested` (the Phase 4b `gmessages-session-refresh` cron emits one of these per active session every 15 min). The receiver HMAC-POSTs `${GMESSAGES_SIDECAR_URL}/sessions/:pairedSessionId/refresh` with body `{}` and logs success/failure. It does **not** rethrow on a sidecar 5xx — Inngest's retry policy is too aggressive for transient sidecar restarts; the next 15-min cron tick re-fans if the session is still stale.

Registered in `packages/queue/src/inngest/index.ts` `inngestFunctions` array next to the Phase 4b functions.

---

## 5. Compose + env

No new vars; no compose changes. `GMESSAGES_SIDECAR_URL` + `PLEXO_SERVICE_KEY` (already wired Phase 4a/4b) are sufficient.

---

## 6. Verification

| Surface | Method | Status |
|---|---|---|
| Sidecar build | `docker run … golang:1.25-alpine sh -c "go vet ./... && go build ./... && go test -count=1 ./..."` | ✅ all green |
| Sidecar tests | `internal/session` + `internal/cryptosvc` + `internal/pex` packages pass | ✅ green |
| API typecheck (Phase 5 code) | `pnpm -F @plexo/api typecheck` filtered to non-pre-existing | ✅ zero new errors |
| Queue typecheck | `pnpm -F @plexo/queue typecheck` | ✅ clean |
| Web typecheck | `pnpm -F @plexo/web typecheck` | ✅ clean |

**Pre-existing TS errors (NOT introduced by Phase 5, carried forward from Phase 4b/4c):**
- `apps/api/src/lib/deepgram.ts:363,577` (Buffer/BlobPart, TS 5.7+ tightening)
- `apps/api/src/routes/telegram.ts:239` (same)

These remain unrelated to gmessages — skip per CLAUDE.md.

**Not verified in 5 (deliberate — needs Phase 6 ops):**
- Live phone-scan + real `*libgm.WrappedMessage` round-trip (no operator-witnessed dev pass yet).
- `RefreshPhoneRelay` against an actually-refreshable session (sidecar code is in; needs a live session under load).
- Inngest cron firing in dev (Inngest installed; functions registered; not exercised end-to-end).
- Sidecar restart semantics — boot restore + outbound POST against a freshly-restored session.

---

## 7. Deviations from the frozen Phase 5 plan

| Deviation | Reason |
|---|---|
| `attachments[].mimeType` envelope field maps to `conversations.attachments[].type` at the API boundary | The `conversations.attachments` schema predates gmessages and uses `type`. Per-API mapping keeps the envelope clean while preserving back-compat with telegram's existing writes. |
| `senderId` envelope field is logged but **not persisted** to `conversations` | `conversations` has no `senderId` column. Phase 6+ ops can decide whether to extend the schema, project from `channelRef`, or sidecar-side enrich. |
| Sidecar's send response carries `messageId` echoing the TmpID we assigned, not a libgm-issued ID | libgm's `SendMessageResponse` doesn't surface a server-side message ID synchronously. The TmpID is what eventually appears on the echo `WrappedMessage`. Phase 6+ could correlate. |
| Outbound persistence uses `reply` field for the outbound text (`message: ''`) | The viewer GET synthesizes `direction:'outbound'` from non-empty `reply`. Avoids a schema change for v0; trade-off is that `conversations.intent` classifier output isn't meaningful for outbound rows (kept null). |

---

## 8. Phase 5 file map

| File | Change | Layer |
|---|---|---|
| `apps/gmessages/internal/pex/types.go` | +`InboundAttachment`; +`SenderID` + `Attachments` on `ChannelInbound` | sidecar |
| `apps/gmessages/internal/session/manager.go` | +`Cmd`/`CmdResult`/`CmdKind` types; +`CmdSend`/`CmdRefresh` constants; +`Session.Cmds` channel; +`Manager.Get(sessionID)` accessor | sidecar |
| `apps/gmessages/internal/session/handler.go` | Type-switch `*libgm.WrappedMessage` → normalized `pex.ChannelInbound`; `*events.GaiaLoggedOut` → `StateRevoked`; replaced bare `<-ctx.Done()` with command-loop reading `sess.Cmds`; +`handleCmd`; +`extractMessageText`/`libgmTimestampToTime` helpers; +`replyAsync` non-blocking reply | sidecar |
| `apps/gmessages/internal/session/http.go` | NEW — `Manager.Handler()` mounting `/sessions/:id/{send,refresh}`; bounded dispatch + reply timeouts; structured error envelopes | sidecar |
| `apps/gmessages/cmd/gmessages/main.go` | +mount `/sessions/` behind HMAC; version → `0.0.4-phase-5-ingest` | sidecar |
| `apps/api/src/lib/gmessages-sidecar.ts` | +`sidecarSessionSend` + `sidecarSessionRefresh` | api |
| `apps/api/src/routes/channels-gmessages.ts` | Replaced `/inbound` stub with real ingest (validate → channel-lookup → dedupe → conversations write → channels.lastMessageAt bump) | api |
| `apps/api/src/routes/channels.ts` | Implemented `/:id/threads` aggregation; implemented `/:id/threads/:threadId/messages` projection (virtual outbound rows from non-empty `reply`); implemented outbound POST → `sidecarSessionSend` + outbound row persistence | api |
| `packages/queue/src/inngest/functions/gmessages-session-refresh-receiver.ts` | NEW — consumer of `gmessages.session.refresh-requested` events | queue |
| `packages/queue/src/inngest/index.ts` | +receiver in `inngestFunctions` array | queue |

---

## 9. Open seams for Phase 6 ops

These intentionally do **not** ship in Phase 5; they belong to the operations slice or a Phase 7+ enrichment pass:

- **Attachment fetch / decrypt / re-upload.** libgm exposes attachment URLs in `WrappedMessage`; v0 emits them on the inbound envelope but the viewer just renders clickable file pills. Phase 6+ should fetch + decrypt (libgm AES-CTR/GCM helpers) + re-upload to the existing Plexo MinIO attachment store, then rewrite the URL.
- **Outbound delivery correlation.** The optimistic `pending: true` flag never flips. Phase 6+ can match the TmpID echo on inbound `*libgm.WrappedMessage` against `idempotencyKey` (stored alongside the outbound conversations row — needs schema nudge or a side table) and emit a `delivered` patch via the existing SSE producer.
- **`reflectAndPromote` memory pipeline integration.** Inbound rows currently land in `conversations` but don't feed the existing classifier/intent/memory paths telegram uses. Phase 6+ should hook the same post-insert path.
- **SSE pub/sub fan-out.** `/api/plexo/channels/:channelId/events` is still a keepalive stub. Phase 6+ should plumb inbound + outbound writes into the in-process pub/sub feeding that stream so the viewer auto-refreshes without polling.
- **Auto-refresh / polling on the viewer.** Phase 4c's message view currently fetches once on mount. Pair with the SSE producer above for a hands-free experience.
- **Read receipts + typing indicators.** libgm supports both. Phase 6+ should surface them on the inbound envelope and render in the viewer.
- **Unread-badge tracking.** `unreadCount: 0` is hardcoded in the threads aggregator. Phase 6+ needs a per-thread last-read marker table or a session-scoped client cache.
- **Sender-name persistence.** `senderId` arrives on the envelope but isn't stored. Either project from `channelRef`, extend conversations schema, or sidecar-enrich via the libgm contact list.

---

## 10. Verification commands

For future operators reproducing the sidecar ship gate:

```sh
# Sidecar
cd /home/dustin/dev/plexo/apps/gmessages
docker run --rm -v "$PWD":/work -w /work golang:1.25-alpine \
    sh -c "go vet ./... && go build ./... && go test -count=1 ./..."

# API + queue + web
cd /home/dustin/dev/plexo
pnpm -F @plexo/api typecheck
pnpm -F @plexo/queue typecheck
pnpm -F @plexo/web typecheck
```

---

## 11. Self-generating handoff (Phase 6 ops)

> Resume `PLEXO-GMESSAGES` Phase 6 (operations) at `/home/dustin/dev/plexo`. Read in order: `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PROGRESS.md`, `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PHASE-5-INGEST.md` (§9 has the open-seams list), `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PHASE-4-PAIRING.md`, `/home/dustin/dev/plexo/adr/0001-gmessages-go-sidecar.md`, `/home/dustin/dev/plexo/plan.md`, `/home/dustin/dev/plexo/checklist.md`.
>
> State: Phase 5 complete (sidecar event normalization + outbound send + refresh receiver + state-machine completion + API ingest + viewer GETs populated + Inngest receiver). Sidecar at `0.0.4-phase-5-ingest`, libgm `v0.2604.0`, Go 1.25. Untested live: phone-scan, `*libgm.WrappedMessage` round-trip, `RefreshPhoneRelay` against a real session, Inngest cron firing in dev, sidecar restart-restore against a Phase 4b boot path.
>
> Phase 6 = **operations**. Master plan §"Phase 6" + the per-phase doc gate. Scope:
> - Pushd deployment manifest for the Go service + supervisor config.
> - Health probes wired to telemetry tables (`apps/gmessages` already exposes `/health` + the binary `-healthcheck` self-probe).
> - Stale-session monitor cron (already shipped Phase 4b — verify in dev).
> - **Runbook entries**: session expired, libgmessages bump, Google protocol drift, connector restart loop. Document the bump cadence (monthly minimum, 5% canary 24h with decode-error counter watch — see `adr/0001`).
> - README in `apps/gmessages/`.
> - Operator-witnessed dev pass: pair a real phone, send + receive a message, force a session expiry, verify the offline banner + Reconnect link, restart the sidecar and confirm boot-restore.
> - Address Phase 5 open seams as scope permits (attachment fetch/decrypt/re-upload is the highest-value follow-up; the rest are Phase 7+).
>
> Phase 6 has the **first production deploy** sign-off gate (master plan §authorization-gates #6). Convene the panel before the deploy to verify ship-gate criteria (tests pass, typecheck clean, go vet/test clean, no unintentional changes, build succeeds, push + deploy targets confirmed).
>
> Pre-existing TS errors in `apps/api/src/lib/deepgram.ts` + `apps/api/src/routes/telegram.ts` (Buffer/BlobPart) are unrelated to gmessages — skip unless operator asks for a parallel chore. `qrcode.react` dep gate (master plan §authorization-gates #8) **still pending** — not blocking but should be resolved before first prod deploy so the pair flow ships with a real QR code.
