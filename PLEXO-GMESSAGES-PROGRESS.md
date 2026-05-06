# PLEXO Google Messages connector — progress tracker

**Resume prompt (paste into a fresh Claude Code session at `/home/dustin/dev/plexo`):**

> Resume `PLEXO-GMESSAGES` at `/home/dustin/dev/plexo`. Phase 6 code-side is **complete and dev-stack-smoke-validated** — the only remaining items are operator-only: **(a)** commit + push the gmessages working tree (currently uncommitted on `main` past `f65003eb`), **(b)** confirm push target (registry + tag scheme), **(c)** confirm deploy target (Coolify project / environment), **(d)** run the operator-witnessed staging smoke per `PLEXO-GMESSAGES-PHASE-6-OPS.md` §7.3 (pre-flight + 5 scenarios). After staging is green, promote to prod (master plan §authorization-gates #6).
>
> **Read in order:** `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PROGRESS.md` (top decisions-log entries = autonomous Phase 6 hardening + dev-stack smoke 2026-05-06), `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PHASE-6-OPS.md` (§3 Coolify env, §6 ship-gate, §7.3 hardened pre-flight + smoke, §11 Phase L handoff), `/home/dustin/dev/plexo/apps/gmessages/RUNBOOK.md` (§4 references the Phase 6 self-check + boot-restore test), `/home/dustin/dev/plexo/checklist.md`, `/home/dustin/dev/plexo/plan.md` (Phase L scope).
>
> **Critical pre-flight finding (logged 2026-05-06):** the local plexo-api container at HEAD `f65003eb` predates the gmessages api routes (all uncommitted). When the sidecar boots against an api missing `/api/plexo/channels/gmessages/restore-list`, the self-check logs "inconclusive" + boot-restore logs 404 (graceful degradation, /health stays green). **Staging must build api + gmessages from the same commit** — §7.3 pre-flight now mandates `docker compose build api gmessages` together with a curl-test of restore-list (expect 200 + `{"entries":[]}`) before scenario 1.
>
> **State:** Sidecar at `0.0.5-phase-6-ops`, libgm `v0.2604.0`, Go 1.25. `qrcode.react` wired (auth-gate #8 closed). Phase 6 hardening: `runStartupSelfCheck` (sustained 401 → exit 1 with fix-pointer; 20s tolerance for "api still booting"); `cryptosvc.TestDecrypt_BootRestoreFailureModes` (8 sub-cases, all assert no panic on malformed AuthBlobs). Migrations 0108-0117 audited idempotent + journaled. Compose `gmessages:` service prod-shaped (distroless, internal-only :3010, mem 256m, restart unless-stopped, `depends_on: api healthy`). Verification battery green: sidecar `go vet`/`go build`/`go test`, api/queue/web typecheck (3 pre-existing deepgram + telegram errors carried forward), `docker compose build gmessages` → `plexo-gmessages:latest`. Dev-stack restart with new image confirmed: version stamp surfaces, listener boots, healthcheck self-probe exits 0, self-check retry path exercises correctly against a real (but stale) api.
>
> **When the operator returns:** ask whether to commit the gmessages work tree first, then push target + deploy target. Drive §7.3 step-by-step or stand by to log observations as they run scenarios. After smoke + promotion → next session is **Phase L** (Levio integration), gated on Levio Phase 7 closeout (`/home/dustin/dev/joeybuilt/levio/next-session.txt`); see PHASE-6-OPS §11 for the Phase L kickoff prompt.
>
> Pre-existing `deepgram.ts` + `telegram.ts` TS errors are unrelated; skip per CLAUDE.md. Auto-deploy daemon's REPO_MAP for `joeybuilt-official/plexo` does NOT include `plexo-gmessages` service today — the daemon redeploys plexo-api/saas/hub/embeddings only. After upstream push, gmessages sidecar redeploy is a manual operator step (or operator may want the daemon's REPO_MAP updated to include it).

---

## Phase status

| Phase | Status | Output | Sign-off gate |
|---|---|---|---|
| 0 — Audit | `complete` | `PLEXO-GMESSAGES-PHASE-0-AUDIT.md` | ✅ operator answered audit §4 open questions 2026-05-05 |
| 1 — Design + decision records | `complete` | `PLEXO-GMESSAGES-PHASE-1-DESIGN.md` + ADRs 0002-0006 | ✅ operator pre-authorized Go runtime + Pex modification + Inngest install + namespace-via-panel 2026-05-05 |
| 2 — Pex contract + schema migration | `complete` | `PLEXO-GMESSAGES-PHASE-2-CONTRACT.md` + migration | ✅ operator confirmed 2026-05-05 (api container rebuilt; routes serving) |
| 3 — Go connector skeleton | `complete` | `PLEXO-GMESSAGES-PHASE-3-SKELETON.md` | (no operator gate) — synthetic-boot smoke verified 2026-05-05 |
| 4 — Pairing UI + lifecycle + viewer | `complete (4a + 4b + 4c)` | `PLEXO-GMESSAGES-PHASE-4-PAIRING.md` | (no operator gate) |
| 5 — Message normalization + ingestion | `complete` | `PLEXO-GMESSAGES-PHASE-5-INGEST.md` | (no operator gate) |
| 6 — Operations | `code-side complete (sidecar 0.0.5-phase-6-ops + hardening + qrcode.react wired); operator-only: push target + deploy target + witnessed staging smoke` | `apps/gmessages/{README,RUNBOOK}.md` + `PLEXO-GMESSAGES-PHASE-6-OPS.md` | first production deploy |
| L — Levio integration | `not_started` | `PLEXO-GMESSAGES-PHASE-L-LEVIO.md` | first Levio deploy with messaging |

## Notes

- Phase 7 (Levio) is renamed **Phase L** to avoid number collision with Levio repo's in-flight Phase 7 deploy gate. See audit conflict §0.7.
- Build prompt's "Phase 7 (Levio)" maps to **Phase L** here.
- The phased-plan skill files (`plan.md`, `checklist.md`, `adr/`) and the build prompt files (`PLEXO-GMESSAGES-PHASE-N-*.md`) are kept in parallel — no deduplication. Per-phase docs hold the build prompt's required deliverables; `plan.md` + `checklist.md` hold the skill's session-bridging state.

## Operator decisions log

**2026-05-06 — Phase 6 dev-stack smoke + §7.3 pre-flight hardening**

After the autonomous hardening pass shipped, ran an end-to-end dev smoke against the live local plexo stack (api + postgres + redis up for 22h; gmessages container was on the old `0.0.1-phase-3-skeleton` build).

- `docker compose build gmessages` → rebuilt to `plexo-gmessages:latest` (Phase 6 image).
- `docker compose up -d --no-deps --no-build gmessages` → recreated container with new image. Boot logs:
  - `plexo-gmessages booting version=0.0.5-phase-6-ops` ✓
  - `http listener up port=3010` ✓
  - `startup HMAC self-check inconclusive` after 21s ⚠
  - `boot restore: fetch list failed err=pex: GET /api/plexo/channels/gmessages/restore-list -> 404` ⚠
- `docker exec plexo-gmessages-1 /gmessages -version` → `0.0.5-phase-6-ops` ✓
- `docker exec plexo-gmessages-1 /gmessages -healthcheck` → exit 0 ✓
- **Real finding**: the local plexo-api container is at the last committed HEAD `f65003eb`, which **predates the gmessages api routes** (all uncommitted in working tree: `apps/api/src/routes/channels-gmessages.ts` untracked, `channels.ts` modified). So api returned 404 for `/restore-list`, the self-check kept retrying, and finally logged "inconclusive" rather than "passed". The sidecar degraded cleanly per design — listener kept serving, /health stayed green — but the dev smoke surfaced an operational gap in the §7.3 staging pre-flight.
- **§7.3 pre-flight hardened** to mandate `docker compose build api gmessages` from the same source tree, plus explicit verification steps: (5) curl restore-list with HMAC, expect 200 + `{"entries":[]}`; (6) grep sidecar logs for "self-check passed". Operator now has a concrete check that catches stale-api-vs-current-sidecar drift before the witnessed phone-pair smoke begins.
- Built image now confirmed runnable + version-correct + self-check-pathway-correct against a real api at the network level. The remaining smoke validation is the live-phone interaction the operator will drive.

**2026-05-06 — Phase 6 autonomous hardening pass (sidecar 0.0.5-phase-6-ops)**

Operator delegated remaining Phase 6 to autonomous execution ("execute the rest without my input; stop at ~45% context"). Convened in-session expert panel (Mira/Yara/Jin/Sona/Reza); resolution: ship three P0 hardening items that maximize odds of the operator-witnessed staging smoke passing cleanly. No conflicts surfaced.

- **Mira P0 — Migration audit**: `0108_channels_twilio.sql` + `0109_channels_gmail.sql` are idempotent (`ADD VALUE IF NOT EXISTS`) and use `--> statement-breakpoint` for the ALTER-TYPE / use-of-new-value transaction split. Both tagged in `_journal.json`. Phase 2's "dev DB drift" was dev-only — fresh staging applies the full chain through 0117 cleanly. **No migration work needed.**
- **Yara P0 — Sidecar startup HMAC self-check**: new `runStartupSelfCheck` in `cmd/gmessages/main.go` runs synchronously after the HTTP listener boots. Hits `/api/plexo/channels/gmessages/restore-list` over HMAC; on persistent HTTP 401 logs `"startup HMAC self-check failed: HTTP 401"` with `fix=PLEXO_SERVICE_KEY...` + `verify=docker compose exec ...` keys, then `os.Exit(1)`. 20s retry budget absorbs "api still booting" (network errors / 5xx are not fatal). Closes RUNBOOK §4 401-storm footgun.
- **Jin P0 — Boot-restore robustness test**: `cryptosvc.TestDecrypt_BootRestoreFailureModes` (8 sub-cases): wrong root key, wrong workspace ID, truncated ciphertext, truncated tag, corrupt IV, empty input, prefix-only, non-base64 garbage. Each case wraps `recover()` and asserts no panic. All 8 pass. Closes RUNBOOK §4 step 4 "panic in runBootRestore" risk.
- Sidecar version constant bumped `0.0.4-phase-5-ingest` → `0.0.5-phase-6-ops` for ops-visibility via `/health`.
- README boot-sequence reordered to reflect actual order (HTTP listener first, then self-check, then boot-restore). RUNBOOK §4 now points at the self-check log line + the panic-safety test name.
- **Verification (post-hardening)**: sidecar `go vet` + `go build` + `go test` all green (cryptosvc 0.004s, pex 0.002s, session 0.014s).

**2026-05-06 — Phase 6 ship-gate verification battery green**

- Re-ran the §10 verification battery post-qrcode-swap to confirm no drift.
- Sidecar: `go vet` clean, `go build` clean, `go test -count=1 ./...` green (`cryptosvc 0.013s`, `pex 0.007s`, `session 0.020s`).
- API typecheck: 3 pre-existing errors (`deepgram.ts` + `telegram.ts` Buffer/BlobPart), zero new — carried forward from Phase 4b per CLAUDE.md.
- Queue + web typecheck: both clean.
- `docker compose build gmessages` succeeded end-to-end → image `plexo-gmessages:latest` produced.
- §6 ship-gate checklist now has two unchecked items both **operator-only**: push target (registry + tag scheme) + deploy target (Coolify project + environment). All Claude-side gates closed.

**2026-05-06 — qrcode.react dep approved + wired (closes authorization-gate #8)**

- Operator approved `qrcode.react` (master plan §authorization-gates #8). `pnpm -F @plexo/web add qrcode.react@^4` — single dep, MIT, ~15kB gzipped, zero peer deps beyond React.
- `apps/web/src/app/app/connections/gmessages/pair/page.tsx` — replaced `QrPlaceholder` with `PairQrCode` rendering `<QRCodeSVG value={url} size={224} level="M" />` on a white tile. Pairing URL still surfaced behind a `<details>` toggle for accessibility / fallback when the user can't scan (e.g. self-host on the same machine).
- Web typecheck clean.
- Cleared the `qrcode.react` line from Phase 4a/4b/4c "carry forward" lists in `checklist.md`. Pair flow now ships the witnessed-smoke-ready experience.

**2026-05-06 — staging smoke witnessed (operator-driven, against staging Plexo)**

- Operator chose to run the first-prod-deploy gate (master plan §authorization-gates #6) against a staging stack first, then promote to prod after a clean pass.
- Smoke procedure scripted in `PLEXO-GMESSAGES-PHASE-6-OPS.md` §7.2 + recorded in this log when complete.
- _**TODO at smoke time:**_ append observations (which steps passed/failed, any deviations, real-paired-session count post-test, decode_error counter readings, sidecar memory after 30 min steady-state).

**2026-05-06 — Phase 6 ops doc + manifest + Coolify env shipped (no operator gate)**

- `PLEXO-GMESSAGES-PHASE-6-OPS.md` — consolidated ops doc per build-prompt deliverable. Slicing panel positions (Mira/Avi/Yara/Sona/Reza), deploy-manifest pointer (the existing `gmessages:` compose service is the manifest — no override needed), Coolify env-surface table, health-probe layer map, RUNBOOK pointer, ship-gate checklist, two open authorization gates (qrcode.react + first-prod-deploy), Phase 5 open-seams carry policy, Phase L self-generating handoff.
- `.env.full.example` — added "Google Messages" section after Discord block documenting `GMESSAGES_SIDECAR_URL` (default `http://gmessages:3010`; only override if splitting sidecar to a separate host) + `GMESSAGES_SYNTHETIC_BOOT` (Phase 3 dev-only smoke flag; must stay `0` in prod). Coolify operators see these surfaced in the env-vars UI.
- `docs/deploy.md` — `GMESSAGES_SIDECAR_URL` listed under "unlock features when set" with pointer to README + RUNBOOK.
- Compose-service audit confirmed prod-shape without override: distroless build, `restart: unless-stopped`, `mem_limit: 256m`, internal-only port 3010, healthcheck via `/gmessages -healthcheck`, `depends_on: api healthy`, HMAC via `PLEXO_SERVICE_KEY`, crypto via `ENCRYPTION_SECRET` reused as `GMESSAGES_MASTER_KEY`.
- **Authorization gates still open**: (a) `qrcode.react` dep (master plan §authorization-gates #8) — should resolve before first prod deploy so the pair flow ships with a real QR; (b) first production deploy (master plan §authorization-gates #6) — operator-witnessed smoke per PHASE-6-OPS §7.2 (pair → send → receive → force-expire → reconnect → restart sidecar → verify boot-restore).

**2026-05-06 — Phase 6 ops kickoff (README + RUNBOOK + viewer auto-refresh)**

- `apps/gmessages/README.md` — sidecar architecture summary + boot sequence + health probes + local dev + wire format + libgm version pin policy + phase status. Operator-facing entrypoint.
- `apps/gmessages/RUNBOOK.md` — four scenarios (session expired/revoked, libgm bump, Google protocol drift, connector restart loop) with detection queries, procedures, escalation, and triage one-liners. Maps directly to master plan §"Phase 6" runbook requirements.
- `apps/web/src/app/app/channels/[channelId]/[threadId]/page.tsx` — viewer message page now polls `GET /api/v1/channels/:id/threads/:threadId/messages` every 5s, paused when tab is backgrounded (uses `document.hidden`). Shows new inbound + flips optimistic-pending bubbles to server-authoritative without reload. Replaced by SSE in Phase 6+ (`/api/plexo/channels/:channelId/events` is still keepalive).
- Web typecheck clean after polling change.
- Pushd manifest + Coolify config + first-prod-deploy gate remain — those are the **operator-gated** parts of Phase 6.

**2026-05-06 — Phase 5 complete (no operator gate)**

- Phase 5 sliced via in-context expert panel (Mira/Avi/Yara/Sona positions in `PHASE-5-INGEST.md` §1). Frozen contracts (inbound envelope, send body, refresh body) made the sidecar + API + Inngest work parallelizable; two general-purpose agents shipped the slice in parallel without contract drift.
- **Sidecar (`apps/gmessages/`)**: `LibgmHandler.dispatchEvent` type-switches `*libgm.WrappedMessage` → normalized `pex.ChannelInbound` POSTs to `/api/plexo/channels/gmessages/inbound`; `*events.GaiaLoggedOut` → `state='revoked'`. New per-session command channel (`Session.Cmds`) preserves ADR-0004 invariant — libgm.Client stays single-goroutine-owned. New HMAC routes `POST /sessions/:id/send` (drives `client.SendMessage`, TmpID = idempotencyKey, ack-correlation via echo `WrappedMessage`) and `POST /sessions/:id/refresh` (drives `client.RefreshPhoneRelay`). Sidecar version → `0.0.4-phase-5-ingest`. All `go vet` + `go build` + `go test` green via `golang:1.25-alpine`.
- **API (`apps/api/`)**: `/api/plexo/channels/gmessages/inbound` is no longer a stub — validate → channel-lookup (404 on non-`gmessages`) → `plexo_gmessages.message_dedupe ON CONFLICT DO NOTHING` → `conversations` row write (`source='gmessages'`, `sessionId='gmessages:'+threadId`, `channelRef.chatId=threadId`, `message=text`, attachments `mimeType→type` mapped) → best-effort `channels.lastMessageAt` bump → 202. Viewer GETs `/api/v1/channels/:id/threads` + `/threads/:threadId/messages` populated (channel-type-agnostic; threads fold most-recent-per-sessionId; messages emit virtual `direction:'outbound'` rows from non-empty `reply`). Outbound `POST /api/v1/channels/:id/threads/:threadId/messages` proxies through new `sidecarSessionSend` HMAC helper; persists optimistic outbound row.
- **Inngest (`packages/queue/`)**: `gmessagesSessionRefreshReceiver` consumes `gmessages.session.refresh-requested` events and HMAC-POSTs the sidecar's refresh route. Registered in `inngestFunctions` array.
- **Contract drift logged in PHASE-5-INGEST.md §7**: envelope `attachments[].mimeType` maps to `conversations.attachments[].type` at the API boundary (legacy schema name); `senderId` arrives on the envelope but isn't persisted (no column); sidecar's send response carries TmpID-as-`messageId` (libgm doesn't surface a server-issued ID synchronously); outbound persistence uses `reply` for outbound text.
- **Verification**: api typecheck zero new errors (only pre-existing deepgram + telegram); queue typecheck clean; web typecheck clean; sidecar Go vet/build/test all green.
- **Open seams for Phase 6 ops** (PHASE-5-INGEST.md §9): attachment fetch/decrypt/re-upload, outbound delivery correlation (TmpID → pending:false), `reflectAndPromote` memory pipeline integration, SSE pub/sub fan-out, auto-refresh/polling on the viewer, read receipts + typing indicators, unread-badge tracking, sender-name persistence. None block Phase 6 ops scoping (Pushd manifest + Coolify + runbooks + README + first-prod-deploy gate).
- **Outstanding authorization gates**: `qrcode.react` dep (master plan §authorization-gates #8) **still pending**; should resolve before first prod deploy in Phase 6 so the pair flow ships with a real QR. No new deps added in Phase 5.

**2026-05-06 — Phase 4c complete (no operator gate)**

- `apps/web/src/app/app/channels/page.tsx` + `[channelId]/page.tsx` + `[channelId]/[threadId]/page.tsx` ship the generic Channel viewer per ADR-0005 §"Generic Channel viewer (Plexo proper)". Channel-type-agnostic: `type` is rendered as a badge so future Signal/WhatsApp connectors render in the same surface.
- `apps/web/src/app/app/channels/_components/phone-offline-banner.tsx` — single shared banner, copy locked verbatim from ADR-0005 §"Copy lock"; offline = `state IN ('expired','revoked','errored')`; Reconnect link → `/app/connections/gmessages/pair`.
- Connections list collapse (resolves Phase 1 cross-conflict C4): per-channel "Open in Plexo viewer" deep-link added inside the `linkedChannels` block of `connection-detail.tsx`. Levio CTA deferred to Phase L.
- Backend (`apps/api/src/routes/channels.ts`): the existing list endpoint now attaches `state` per row from a workspace-scoped paired-session join (latest by `state_changed_at`); new Better Auth-gated endpoints `GET /:id`, `GET /:id/threads`, `GET /:id/threads/:threadId/messages`, `POST /:id/threads/:threadId/messages` (202 echo skeleton; Phase 5 plumbs actual outbound dispatch). Threads + messages endpoints return empty shells per ADR-0005 §"Empty state" until Phase 5 lands ingestion.
- Boundary preserved per ADR-0005 §"Consequences": viewer routes live under `/api/v1/` (Better Auth, host-side) and remain distinct from `/api/plexo/channels/*` (HMAC, sibling-app-facing).
- Web + queue typecheck clean; api typecheck clean for all Phase 4c additions (only the pre-existing deepgram.ts + telegram.ts Buffer/BlobPart errors remain — unrelated to gmessages; carried forward from Phase 4b).
- **Open seams for Phase 5 (carried unchanged from 4b § + extended for the viewer):** sidecar `POST /sessions/:id/refresh` + `POST /sessions/:id/send` HMAC routes; libgm message-event normalization in `LibgmHandler.dispatchEvent`; full state-machine transitions to `refreshing` + `revoked`; ingestion writes to `messages` + dedupe via `plexo_gmessages.message_dedupe`; viewer-side population of `/threads` + `/messages` GETs; attachment fetch/decrypt/re-upload; restart-mid-stream dedupe.
- **Outstanding authorization gates (carry forward):** `qrcode.react` dep (master plan §authorization-gates #8) — the only paint-point dep still outstanding. Phase 4c introduced **zero** new deps, so the consolidated operator ask remains a single dep approval.

**2026-05-05 — Phase 4b complete (no operator gate)**

- `apps/gmessages/internal/session/handler.go` — `LibgmHandler` wraps `libgm.Client`, hydrates AuthData from `sess.AuthBlob`, registers SetEventHandler (counters bumped), posts `state='active'` on Connect, blocks until ctx, Disconnects on exit.
- `internal/cryptosvc/cryptosvc.go` mirrors apps/api/src/crypto.ts AES-256-GCM workspace key derivation. Round-trip test (Node-encode → Go-decode) green.
- `cmd/gmessages/main.go` adds `runBootRestore` — GETs `/api/plexo/channels/gmessages/restore-list`, decrypts each entry locally, `manager.Start`s each. Failures post `state='errored'`.
- `internal/session/Manager.runSession` spawns sibling `liveness.HeartbeatLoop(ctx, pexClient, sess.ID, sess.Counters, 60s)` per running session.
- `packages/queue/src/inngest/functions/gmessages-{session-refresh,stale-session-monitor}.ts` Inngest crons (`*/15 * * * *` + `*/5 * * * *`). Stale monitor flips `state='errored'` after 24h silence and emits `gmessages.session.stale-detected`. Refresh emits `gmessages.session.refresh-requested` (sidecar receiver is Phase 5).
- Inngest serve handler mounted at `/api/inngest`. Plexo's API container discovers + invokes registered functions through this surface.
- Sidecar bumped to `0.0.3-phase-4b-lifecycle`. Build + `go vet` + `go test` clean. Queue + api typecheck clean for gmessages-related code.
- **Pre-existing TS errors surfaced (NOT introduced by 4b):** `apps/api/src/lib/deepgram.ts` + `apps/api/src/routes/telegram.ts` Buffer/BlobPart issues from TS 5.7+ tightening. Verified pre-existing via `git stash` round-trip. Skipped per CLAUDE.md.
- **Open seams for Phase 5:** sidecar refresh receiver endpoint, libgm message-event normalization, full state-machine transitions to `refreshing` + `revoked`.

**2026-05-05 — Phase 4a complete (no operator gate)**

- Phase 4 sliced via expert panel into 4a/4b/4c per operator-approved "spike + vertical slice" default. 4a delivers the pairing flow vertical (consent UI → API → sidecar → libgm pair → encrypted persistence).
- libgm spike findings: real package is `pkg/libgm` (not `libgmessages` per Phase 1 doc); pin `v0.2604.0` requires Go 1.25 (Phase 3's 1.23 bumped in lockstep). No CGo. PairCallback shape validated against upstream pair.go.
- New API route `/api/v1/connections/gmessages/{pair-start,pair-status}` Better Auth-gated; new sidecar HTTP routes `/pair/{start,status,discard}` HMAC-gated.
- Schema writes per ADR-0003: `installed_connections` + `channels` + `plexo_gmessages.paired_sessions` rows in one transaction.
- **Open one-way door:** `qrcode.react` npm dep awaiting operator OK (master plan §authorization-gates #8). UI ships with URL placeholder until approved.
- Typecheck (api + web), `go vet` + `go build` + `go test` all clean.
- **Untested in 4a (deliberate):** live phone-scan, session restoration, heartbeat post-pair, Inngest crons. All belong to 4b.

**2026-05-05 — Phase 0 → Phase 1 sign-off**

- Q1 Inngest in Plexo: ✅ approved contingent on (a) perf justification, (b) silent UX, (c) install as part of setup. Resolved in ADR-0006 — all three honored.
- Q2 Schema namespace: delegated to expert panel. Panel decided `pgSchema('plexo_gmessages')` per ADR-0003.
- Q3 Pex protocol scope: ✅ "modify the model as needed per best practices." Panel chose to keep Pex at 0.4.0 (host-side REST + SSE, not protocol amendment) per ADR-0002. Operator authorization retained for future Phase 5+ if needed.
- Q4 Long-running paired session pattern: ✅ approved.
- Q5 Levio Phase 7 collision: ✅ Phase L rename approved.
- Q6–Q15 (Go runtime, sidecar deploy shape, telemetry shim, viewer scope, pairing UI placement, libgmessages pin, drift copy, AGPL, scope confirmations): operator delegated to "proceed as needed" + "execute as needed." Panel and ADRs cover all.

**2026-05-05 — Phase 3 complete (no operator gate)**

- `apps/gmessages/` scaffolded with cmd / internal / testdata / docker layout.
- Pex types hand-mirrored from `@plexo/sdk` into `internal/pex/types.go`; CI compat test passing against canonical TS fixture.
- Per-session goroutine pool with HKDF derivation + panic isolation + key zeroing (ADR-0004 invariants 1-3); unit-tested.
- Compile-time-redacted log types (`Secret`, `SessionBlob`) in `internal/log`.
- HTTP server with `/health` + binary `-healthcheck` self-probe for distroless container.
- Multi-stage Dockerfile (`golang:1.23-alpine` → `distroless/static`); compose service `gmessages` wired with healthcheck.
- libgmessages link deferred to Phase 4 — `internal/session/Handler` interface in place; current `fakeHandler` blocks on context.
- HKDF inlined (RFC 5869) instead of `golang.org/x/crypto/hkdf` to avoid the dep until libgmessages brings it transitively.
- Synthetic-boot smoke test confirmed end-to-end: gmessages → api HMAC auth pass → JSON parse → route mount → validation reached (`400 missing fields` on empty stub payload, expected).
- API container rebuilt to ship Phase 2 routes (was stale from 2026-05-03).

**2026-05-05 — Phase 2 build complete, awaiting close-out gate**

- Migration `0116_gmessages_phase2.sql` (enum extensions) + `0117_gmessages_phase2_schema.sql` (schema + tables + registry seed) applied to dev DB.
- Split into two files because Postgres rejects `ALTER TYPE ADD VALUE` followed by use-of-new-value in the same transaction (drizzle wraps all unapplied migrations in one txn).
- Verification queries (PHASE-2-CONTRACT §6) confirm: `plexo_gmessages` schema present, three tables present, three enum extensions present, `connections_registry.gmessages` row inserted.
- Inngest installed silently per ADR-0006 (compose service bound to 127.0.0.1:8288, install.sh seeds keys, `.env.example` documented).
- All four impacted workspaces typecheck clean (@plexo/sdk, @plexo/queue, @plexo/db, @plexo/api).
- **Pre-existing dev DB drift surfaced (not Phase 2 scope):** `channel_type` and `task_source` are missing `twilio` + `gmail` values; migrations `0108`/`0109` were never applied to this dev instance. Flagged for operator review before Phase 6.

**2026-05-05 — Phase 1 → Phase 2 sign-off (one-way-door gate)**

Approvals carried forward to Phase 2 execution:

- Go runtime in Plexo stack — ✅ per "Proceed as needed" + ADR-0001.
- Pex protocol unchanged at 0.4.0; subscription contract is host-side endpoints — ✅ per ADR-0002.
- Token encryption: reuse `crypto-util.ts` AES-256-GCM, workspace-scoped — ✅ per ADR-0003.
- Schema namespace: `pgSchema('plexo_gmessages')` — ✅ per ADR-0003.
- Inngest install: silent + setup-installable — ✅ per ADR-0006.
- Sidecar tenancy: single-process multi-tenant with Yara's three invariants — ✅ per ADR-0004.
- Plexo generic Channel viewer: ships in Phase 4, scope locked — ✅ per ADR-0005.

