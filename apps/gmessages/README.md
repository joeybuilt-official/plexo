# apps/gmessages — Google Messages Go sidecar

Single-process multi-tenant Go service that drives `go.mau.fi/mautrix-gmessages/pkg/libgm` (the upstream Google Messages Web protocol library — the directory is `pkg/libgm`, **not** "libgmessages" as Phase 1 docs sometimes call it). Hosts paired phone connections, normalizes inbound libgm events into Plexo Pex `ChannelInbound` envelopes, and dispatches outbound text from Plexo Core back through libgm to the phone.

License: AGPL-3.0-only (libgm is AGPL-3; the SPDX header on every file enforces). Plexo Core itself is AGPL-3.0-only as a whole repo.

---

## Architecture summary

- **Single process, multi-tenant** — `internal/session/Manager` owns a per-`pairedSessionId` goroutine that runs `Handler.Run(ctx, sess)`. The libgm.Client never crosses goroutines (ADR-0004 invariant 1). HTTP handlers serialize work onto the owning goroutine via a per-session `Cmds chan Cmd` (Phase 5 addition).
- **Layered liveness** — process probe via `/health`, library probe via libgm's internal long-poll, flow heartbeat via `internal/liveness.HeartbeatLoop` posting to `/api/plexo/channels/gmessages/heartbeat` every 60s. ADR-0004.
- **Inbound** — `LibgmHandler.dispatchEvent` type-switches `*libgm.WrappedMessage` and POSTs `pex.ChannelInbound` envelopes to `/api/plexo/channels/gmessages/inbound`. `*events.GaiaLoggedOut` posts `state='revoked'`. Decode errors bump `Counters.MarkDecodeError` for the layered liveness probe.
- **Outbound** — Plexo API HMAC-POSTs `/sessions/:pairedSessionId/send`. The HTTP handler hands a `Cmd{Kind: CmdSend, …}` to the owning goroutine; the goroutine calls `client.SendMessage` and replies with the libgm `TmpID` (which echoes back on the eventual `WrappedMessage` ack — standard libgm correlation pattern).
- **Refresh** — Inngest `gmessages.session.refresh-requested` events fire every 15 min via the Phase 4b cron. The receiver in `packages/queue` HMAC-POSTs `/sessions/:pairedSessionId/refresh`, which calls `client.RefreshPhoneRelay()` on the owning goroutine. The terminal state (`active` / `errored`) is posted via `PexClient.SendStateChange`.
- **Pairing** — `internal/pair` owns the QR pairing flow. `/pair/start` returns the libgm pair URL; the user scans on the phone; the `PairCallback` fires; the encrypted AuthData blob is stored via Plexo API → `installed_connections.credentials`. ADR-0005 §"Pairing UX".
- **Crypto** — `internal/cryptosvc` mirrors `apps/api/src/crypto.ts` AES-256-GCM workspace-keyed derivation. The sidecar decrypts AuthData blobs locally on boot rehydration (`runBootRestore`) — Plexo API never returns plaintext libgm credentials over the wire.
- **Layout invariant** — every Go file carries the AGPL-3.0-only SPDX header. Sensitive types use the compile-time-redacted `internal/log.Secret` + `internal/log.SessionBlob` wrappers so structured logs can never accidentally serialize a key or auth blob.

---

## Boot sequence

1. Read env (`PLEXO_BASE_URL`, `PLEXO_SERVICE_KEY`, `ENCRYPTION_SECRET`/`GMESSAGES_MASTER_KEY`, `PORT`).
2. Construct `pex.Client` for outbound posts to Plexo Core.
3. Construct `session.Manager` with the master key + handler + pex client.
4. Construct `cryptosvc.Service` mirroring Plexo's AES-256-GCM scheme.
5. Mount HTTP routes:
   - `/health` (anonymous, used by Docker healthcheck)
   - `/pair/{start,status,discard}` behind `httpauth.RequireHMAC`
   - `/sessions/{:id/send, :id/refresh}` behind `httpauth.RequireHMAC`
6. `http.ListenAndServe` on `:PORT` (default 3010).
7. **Startup HMAC self-check** (Phase 6 — `runStartupSelfCheck`) — synchronous HMAC-authed GET against Plexo Core. A persistent HTTP 401 (`PLEXO_SERVICE_KEY` mismatch with the api container) exits 1 with a fix-pointer rather than emitting 401 storms during normal session work. 20s retry budget tolerates "api still booting." See RUNBOOK §4.
8. **Boot restore** — `runBootRestore` GETs `/api/plexo/channels/gmessages/restore-list` (HMAC-authed), decrypts each entry locally, calls `manager.Start` per row. Failures post `state='errored'`. All decrypt failure modes are explicitly covered by `cryptosvc.TestDecrypt_BootRestoreFailureModes` (wrong key, wrong workspace, truncated ciphertext, corrupt IV, garbage input) — the loop continues to the next entry rather than panicking.

---

## Health probes

- **Liveness (process)**: `GET /health` → `{ "ok": true, "version": "..." }`. Used by Docker `HEALTHCHECK`.
- **Healthcheck self-probe**: the binary supports `gmessages -healthcheck` for the distroless image (no shell). Returns exit 0 if the local HTTP server responds.
- **Library**: libgm's long-poll connection state. Currently inferred from `Counters.LastInbound`; a future Phase 6+ enhancement could expose libgm's internal `Connected()` flag.
- **Flow**: `internal/liveness.HeartbeatLoop` posts `/heartbeat` every 60s with `{ pairedSessionId, lastInboundAt, decodeErrorCount }`. Plexo Core's stale-session monitor (Inngest `gmessages-stale-session-monitor`) flips a session to `errored` when `lastInboundAt < now - 24h`.

---

## Local development

```sh
cd apps/gmessages

# Local build (requires Go 1.25+)
make build && ./bin/gmessages

# Tests
make test

# Docker-only build (no local Go required)
make docker-build

# Vet
make vet
```

For codepath verification without a phone:

```sh
docker run --rm -v "$PWD":/work -w /work golang:1.25-alpine \
    sh -c "go vet ./... && go build ./... && go test -count=1 ./..."
```

---

## Wire format

### Inbound envelope (`POST /api/plexo/channels/gmessages/inbound`)

```json
{
  "workspaceId": "<uuid>",
  "channelId":   "<uuid>",
  "threadId":    "<gmessages thread id, text>",
  "gmessagesMsgId": "<canonical Google Messages msg id — dedupe key>",
  "text":        "<plain text body>",
  "sentAt":      "<RFC3339>",
  "senderId":    "<optional, phone or contact ref>",
  "attachments": [
    { "url": "<https url>", "mimeType": "<MIME>", "filename": "<optional>" }
  ]
}
```

### Send (`POST /sessions/:pairedSessionId/send`)

```json
{ "threadId": "<gmessages thread id>", "text": "<plain text>", "idempotencyKey": "<optional ulid>" }
→ 202 { "messageId": "<libgm TmpID, echoed on ack WrappedMessage>" }
```

### Refresh (`POST /sessions/:pairedSessionId/refresh`)

```json
{}
→ 202 { "state": "active" | "refreshing" | "errored" }
```

### State change (sidecar → Plexo, `POST /api/plexo/channels/gmessages/state`)

```json
{ "pairedSessionId": "<uuid>", "state": "<paired|active|refreshing|expired|revoked|errored>", "errorDetail": "<optional>" }
```

### Heartbeat (sidecar → Plexo, `POST /api/plexo/channels/gmessages/heartbeat`)

```json
{ "pairedSessionId": "<uuid>", "lastInboundAt": "<RFC3339>", "decodeErrorCount": 0 }
```

All sidecar↔Plexo HTTP traffic uses the shared `PLEXO_SERVICE_KEY` HMAC-SHA256 envelope (`X-Plexo-Signature: sha256=<hex>`, `X-Plexo-Timestamp: <RFC3339>`, `X-App-Id: <plexo-api|gmessages-sidecar>`). 5-minute timestamp skew. Mirror of `apps/api/src/middleware/hmac-service.ts`.

---

## libgm version pin policy

ADR-0001 / Phase 1 §3.6:

- **Pin**: specific git tag (currently `v0.2604.0`). Never use `latest` or float a branch.
- **Bump cadence**: **monthly minimum**. libgm tracks Google's Web protocol; staying within one month of upstream limits drift exposure.
- **Canary**: when bumping, deploy to **5% of paired sessions** for **24h** while watching `decode_error_count` per session. If any session crosses ~10 decode errors/hour or `lastInboundAt` ages past expected idle window, **roll back**.
- **Go version**: bump in lockstep with libgm if libgm's `go.mod` requires a newer Go (libgm `v0.2604.0` requires Go 1.25; Phase 4a bumped from 1.23 → 1.25 alongside the first libgm pin).

---

## Phase status

| Phase | Status |
|---|---|
| 3 — Skeleton | ✅ complete (Go-1.23 → 1.25 in 4a) |
| 4a — Pairing flow | ✅ complete |
| 4b — Lifecycle (boot restore + heartbeat + Inngest crons) | ✅ complete |
| 4c — Generic Channel viewer (web side) | ✅ complete |
| 5 — Message normalization + ingestion | ✅ complete |
| 6 — Operations + first prod deploy | ✅ deployed to prod 2026-05-06 22:49 UTC (sidecar `plexo-gmessages` on joeybuilt VPS at `0.0.5-phase-6-ops`); operator-witnessed §7.3 phone-pair smoke deferred |
| L — Levio integration | not started |

Sidecar version constant lives in `cmd/gmessages/main.go`. Bump per phase.

Cross-references:
- `/PLEXO-GMESSAGES-PROGRESS.md` — full status tracker + decisions log.
- `/PLEXO-GMESSAGES-PHASE-N-*.md` — per-phase build prompt outputs.
- `/adr/000{1,2,3,4,5,6}-*.md` — decision records.
