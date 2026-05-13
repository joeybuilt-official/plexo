# PLEXO Google Messages connector — Phase 0 audit

**Status:** awaiting operator review
**Date:** 2026-05-05
**Repo state:** main @ `f65003eb` (clean apart from untracked `ops/harnesseval/`)
**Sibling repo state:** levio main @ `b2681d2` — Phase 7 deploy gate pending per `/home/user/dev/joeybuilt/levio/next-session.txt`. Audit-time conflict surfaced below.
**Reads only.** No code, no schema, no proposals.

---

## 0. Audit-time conflicts with the build prompt as written

The build prompt encodes assumptions that the current Plexo codebase does not match. Each must be resolved before Phase 1.

| # | Build prompt asserts | Reality in repo | Resolution required |
|---|---|---|---|
| 0.1 | "**Inngest** for any durable background work touching Plexo Core." | Plexo has no Inngest dep. Background work uses a custom DB-backed queue (`packages/queue/src/index.ts`, `tasks` table, ULID, claim timeout) and Express cron routes. Inngest is a **Levio** convention, not a Plexo one. | Decide: durable jobs in the connector go through Plexo's `tasks` queue, or this build introduces Inngest to Plexo. Both are one-way doors. |
| 0.2 | "**`plexo_ops` schema** + Pushd SDK for telemetry." | No `plexo_ops` pgSchema exists. Telemetry tables (`plexo_ops_domain_metrics`, `plexo_ops_task_events`) live in the public schema with a name prefix. Only `pushd` is a true `pgSchema`. | Decide: do we keep the prefix convention, or actually create the `plexo_ops` schema as part of this build? |
| 0.3 | "**Per-app PostgreSQL schema namespacing.** This connector gets its own schema." | Schema is monolithic in `packages/db/src/schema.ts` (2056 lines, 60+ tables, all in `public`). Only `pushd` has its own pgSchema (`packages/db/src/pushd-schema.ts`). | Decide: introduce `plexo_gmessages` pgSchema (true namespace), or follow the existing convention with `gmessages_*` table prefixes in `public`. |
| 0.4 | "Pex **Connector** for Google Messages." | Per `docs/pex/SPEC.md` §2.1, Extension subtypes are `skill`, `channel`, `tool`, `connector`. A messaging surface is canonically a **`channel`** extension. `connector` is reserved for credential-bridge extensions that don't carry traffic. | Decide: the new extension is type=`channel` (recommended — matches `slack-channel`, `telegram-channel` placeholder dirs), with the long-running paired-session implemented as a host-side service. The terminology "Pex Connector" in the prompt is interpreted accordingly. |
| 0.5 | "Pex **Channel subscription contract** for sibling apps — Levio is canonical first consumer." | The Plexo↔Levio sibling-app contract already exists in two halves: (a) Plexo agent calls Levio data via `packages/agent/src/connections/factories/levio.ts` → Levio's `/api/plexo/data` (service-key auth); (b) Levio receives Plexo events via `/api/plexo/events` (HMAC). It is a paired REST + webhook contract, **not** a subscription/SSE protocol today. There is no published Pex SDK method for "subscribe to Channel X." | Decide: Phase 2 lands a new subscription contract (one-way door, Pex protocol addition), or extends the existing data/events HMAC pattern. ADR-03 in Levio (`/home/user/dev/joeybuilt/levio/decisions/ADR-03-channel-ownership.md`) names a hypothetical `plexo.channel.dispatch({...})` SDK method that the operator already flagged as unconfirmed. |
| 0.6 | "**Generic Channel viewer** in Plexo (recommended default)." | `apps/web/src/app/app/connections/` lists installed connections; `apps/web/src/app/app/settings/channels/page.tsx` exists for channel settings. **No threaded-message viewer exists today** for any channel — Telegram/Discord traffic is dispatched but not rendered in Plexo's web UI. The first thread viewer in Plexo would land here. | This is a real net-new Plexo surface. Confirm scope: thread list + message view + send composer minimum. |
| 0.7 | "Levio integration in Phase 7." | Levio is mid-flight on its **own** Phase 7 (revamp Phase 7), with deploy gate pending — `LEVIO-REVAMP-PHASE-7-PLAN.md`. Stacking a second "Phase 7" with overloaded numbering will cause confusion and possibly merge collisions in `/home/user/dev/joeybuilt/levio/`. | Rename the Levio integration phase in this build to something disambiguated (e.g. **Phase L**) and gate it behind Levio's existing Phase 7 closeout. |
| 0.8 | "**Better Auth** for any user-facing auth surfaces." | Confirmed — Better Auth is in use (`packages/db/src/auth/`). No conflict. | None. Honor as written. |
| 0.9 | "Drizzle ORM for any schema additions." | Confirmed (`packages/db/drizzle.config.ts`). No conflict. | None. Honor as written. |
| 0.10 | "AGPL-3.0 across all files." | Confirmed across factory files. No conflict. | None. Honor as written. |
| 0.11 | "Pex 0.4.0 is the protocol; don't propose 0.5 changes unless explicitly scoped." (Carried from Levio bootstrap.) | Pex SPEC at `docs/pex/SPEC.md` is v0.4.0. The build prompt asks for Channel subscription contract + possible Pex extensions — that **is** scope creep beyond 0.4.0. | Operator must explicitly authorize a Pex 0.5 amendment, or the contract must fit inside 0.4.0 surface. |

These eleven items are the most important output of this audit. The rest of the document is supporting evidence.

---

## 1. OSS benchmark

| Implementation | Pairing | Session lifecycle | Message normalization | Attachments | RCS vs SMS divergence | Protocol drift handling | Operational scale | License |
|---|---|---|---|---|---|---|---|---|
| **mautrix-gmessages** *(only serious in-the-wild Google Messages Web protocol impl)* | QR scan via phone Messages app, OR Google account cookie auth (SID/HSID/SSID/OSID/APISID/SAPISID, sometimes `__Secure-1PSIDTS`); QR being deprecated by Google. Phone must stay online — all msgs proxied through phone. | Cookie sessions silently rot after "a couple of days" while `ping` still reports active; v0.6.0 (Dec 2024) added re-auth without re-pairing. Single primary browser per account. | Single event type with RCS feature flags layered on; SMS/MMS/RCS not separately modeled in roadmap. | Encrypted blobs via `pkg/libgm/crypto` (AES-CTR + AES-GCM helpers), downloaded then re-uploaded to Matrix media repo. | Replies, reactions, typing, read receipts gated to RCS only per ROADMAP; rich cards / suggested replies absent. | Detects via decode failures (`string field contains invalid UTF-8`, `Skipped DataEvent action=16`); no auto-recovery — full re-pair required. Releases cadence reflects ongoing reverse-eng churn (v0.2604 by 2026). | Single-user puppeting bridge; multi-tenant via Beeper. | AGPL-3.0 |
| **mautrix-imessage** | OS-level — runs on the user's Mac (mac/mac-nosip) or BlueBubbles server; Android-SMS connector deprecated. Websocket proxy fronts the homeserver. | Tied to host machine uptime; no protocol session to refresh — the bridge IS the device. | Distinct connectors per backend (mac, mac-nosip, bluebubbles, android-sms); features differ per connector matrix. | Native macOS attachment store, re-uploaded to Matrix; iMessage E2E preserved on-device. | iMessage gets tapbacks, edits/unsends (BB ≥1.9.6), typing; SMS-via-Mac is degraded; android-sms had no RCS. | Per-connector — protocol drift is Apple's, surfaced by BlueBubbles updates; mac-nosip needs SIP off. | Self-host on a physical Mac per account; Beeper ran Mac-mini farms historically. | AGPL-3.0 |
| **matrix-appservice-sms** / Android-companion bridges | Companion APK on the phone holds SMS perms; bridge auths via shared token. | Lives as long as the phone process; Android Doze and OEM kills are the failure mode. | SMS + MMS only, flattened to one text+media event; no RCS surface at all. | MMS blobs uploaded to homeserver media; no E2E at protocol level. | RCS not accepted — protocol-level no-op. | N/A — uses public Android SMS APIs. | Single-user; the canonical `matrix-org/matrix-appservice-sms` repo is gone (404) — abandoned. mautrix-imessage's android-sms supplanted it and is also deprecated. | originally Apache-2.0; mautrix variants AGPL-3.0 |
| **KDE Connect / GSConnect** | Mutual TLS pairing — UDP identity broadcast 1714–1764, TCP-back, certificate-pinned exchange + accept prompt on each side. | Persistent paired cert; no remote session — re-discovery on every LAN join. | SMS/MMS retrieved from Android via companion app; no protocol-level RCS. | SFTP mount for files; SMS attachments inline JSON-RPC. | RCS-enabled threads silently downgraded to SMS/MMS — Android does not expose RCS to 3rd-party apps (KDE bug 464654). | None needed. | Strictly per-user, same-LAN — fundamentally incompatible with hosted SaaS, no NAT traversal. | GPL-2.0 |
| **Beeper (mautrix-gmessages at scale)** | Same QR/cookie pairing; requires Google Messages set as default SMS app on Android. | Per-user bridge instance on Beeper's Matrix homeserver; Beeper holds tokens & keys. New "Build a Beeper Bridge" (Oct 2025) and bridge-manager push self-hosted bridges into the hosted homeserver. | Inherits mautrix-gmessages model. | Re-uploaded to Beeper's Matrix media; E2E via Matrix room keys. | Inherits gmessages roadmap; RCS shipped Aug 2023 once upstream landed it. | Aggregated detection across many tenants → same upstream re-pair fix. | Multi-tenant SaaS; bridges run server-side per user. | Bridges AGPL-3.0; service proprietary |

**Patterns observed**

- **QR is a stopgap; cookie/OAuth is the survivable path.** Google has signaled QR death; mautrix-gmessages added cookie-only re-auth in v0.6.0 (Dec 2024). Treat QR as bootstrap-only and persist refreshable Google credentials. *(mautrix-gmessages, Beeper.)*
- **The phone is always in the path.** Every working impl proxies through the user's handset. Connector design must treat "user's phone offline" as a first-class state. *(mautrix-gmessages, KDE Connect, Beeper.)*
- **RCS is a strict superset overlay, not a separate channel.** Roadmaps gate replies/reactions/typing/receipts on `is_rcs`; SMS path silently drops. One event type with capability flags beats two pipelines. *(mautrix-gmessages, mautrix-imessage iMessage-vs-SMS analogue.)*
- **Attachments need re-upload + re-encryption, not URL passthrough.** Google CDN URLs are ephemeral and AES-wrapped (`libgm/crypto`); every serious bridge fetches, decrypts, re-uploads. *(mautrix-gmessages, mautrix-imessage.)*
- **Protocol drift is detected via decode errors, not health checks.** UTF-8 decode failures and unknown action codes are the canonical "Google rotated something" signal — pings keep reporting healthy. Surface decode-error counters as the real liveness probe. *(mautrix-gmessages issue #3.)*

**What aged poorly**

- **Trusting `ping`/session-active flags as liveness.** mautrix-gmessages issue #3: session reports active while ingress is dead for days. Layer message-flow heartbeats on top of any library-level health signal.
- **Android-companion SMS bridges as the strategy.** `matrix-appservice-sms` is gone, mautrix-imessage's `android-sms` connector is deprecated, and KDE Connect can't touch RCS at all because Android won't expose it to 3rd parties. Dead end for anything beyond legacy SMS.
- **LAN-pinned pairing models.** KDE Connect's TLS+cert-pin LAN model is elegant for desktops but cannot retrofit to a hosted sidecar — no NAT traversal, requires user-side daemon online.

---

## 2. Plexo internal inventory

### 2.1 Pex protocol surface

- `docs/pex/SPEC.md` — v0.4.0, authoritative, 2416 lines.
- §1.1 names three pillars: **Connection**, **Extension**, **Agent**.
- §2.1 Extension subtypes: `skill`, `channel`, `tool`, `connector`. Google Messages is properly a `channel` (with attached `connector` for credential bridging if useful).
- §6 Message Protocol envelope, §7.3 Channel Router, §7.4 Event Bus all relevant. §13.1 Credential Handling sets the bar for token storage.
- `docs/pex/MANIFEST.md`, `docs/pex/agent-manifest.md` — manifest format.
- `packages/sdk/src/types/manifest.ts` — TS types for manifest.

### 2.2 Existing channel implementations

The placeholder pattern is `extensions/core/<channel>-channel/` containing only `package.json`. Real runtime code lives elsewhere:

- `extensions/core/slack-channel/` — placeholder only.
- `extensions/core/telegram-channel/` — placeholder only.
- `apps/api/src/routes/telegram.ts` (1613 lines) — inbound webhook handler.
- `apps/api/src/routes/discord.ts` — inbound.
- `apps/api/src/channel-dispatch.ts` (251 lines) — outbound dispatch with idempotency keys backed by Redis (`IDEMPOTENCY_REDIS_TTL_SECONDS`) and an in-memory fallback. Allowed channels enum: `['telegram', 'email', 'push', 'sms']`.
- `apps/api/src/routes/channel-dispatch.ts` — HTTP wrapper for outbound dispatch.
- `apps/api/src/channel-ai.ts`, `apps/api/src/channel-delivery.ts`, `apps/api/src/channel-state-format.ts`, `apps/api/src/conversation-log.ts`, `apps/api/src/sse-emitter.ts` — channel-side pipeline plumbing.

**Implication:** there is no runtime example today of a long-running paired-session channel. All current channels are webhook-based or service-API-based. The Go sidecar pattern is fully novel.

### 2.3 Connection lifecycle

- `packages/agent/src/connections/registry.ts` (652 lines) — central registry.
- `packages/agent/src/connections/bridge.ts` (974 lines) — `ConnectionCredentials`, `ToolSet`, factory glue.
- `packages/agent/src/connections/bridge-types.ts` — types.
- `packages/agent/src/connections/factories/*.ts` — per-service factories. Existing: `airtable, discord, gmail, google-calendar, google-drive, google-workspace, jira, levio, linear, notion, ssh, telegram` plus `stubs.ts`.
- `packages/agent/src/connections/approval-guard.ts`, `write-tool-filter.ts` — scope-restricted tool access.
- `apps/api/src/routes/connections.ts` (1265 lines) — REST API for create/refresh/expire/revoke + per-service test endpoints.
- `apps/api/src/routes/credential-setup.ts` — credential intake flow.
- `apps/web/src/app/app/connections/` — installed-connections list UI; `_components/connection-detail.tsx`, `_components/badges.tsx`.

### 2.4 Encryption-at-rest

- `packages/agent/src/connections/crypto-util.ts` (46 lines) — AES-256-GCM. Workspace-scoped key derivation. Format: `enc:{iv}.{ciphertext}.{authTag}` (base64url). Already used by all existing connection factories.
- `installedConnections.credentials` jsonb stores ciphertext blobs.
- This is reusable as-is for libgmessages session blobs. No new encryption primitive needed.

### 2.5 Schema

- `packages/db/src/schema.ts` (2056 lines, monolithic) — single file, all in `public` schema except `pushd_*`.
- Relevant existing tables:
  - `channels` (line 280) — generic channel rows; `type: channel_type` enum, `config: jsonb`, error counters, `lastMessageAt`.
  - `channelTypeEnum` (line 34) — values: `telegram, slack, discord, whatsapp, signal, matrix, irc, webchat, twilio, gmail`. **No `gmessages` slot. Adding it is a Drizzle migration.**
  - `connectionsRegistry` (line 836) — catalog of available connections (`id` like `'github'`, `'stripe'`).
  - `installedConnections` (line 854) — per-workspace installs; `credentials` jsonb encrypted.
  - `messageDeliveries` (line 1724) — outbound delivery tracking; `channel` text column today carries `telegram | slack | discord` only.
  - `conversations`, `tasks`, `taskSteps`, `memoryEntries`, `memoryEmbeddings`, `attachmentScanQueue` — downstream consumers of canonical messages.
- `packages/db/src/pushd-schema.ts` — `pgSchema('pushd')` example to mirror if we go true-namespace.
- `tasks.source` enum (in `packages/queue/src/index.ts`): `'telegram' | 'slack' | 'discord' | 'scanner' | 'github' | 'cron' | 'dashboard' | 'api' | 'extension' | 'sentry' | 'a2a' | 'webhook' | 'twilio' | 'gmail'`. **No `gmessages`.**

### 2.6 Background work

- No Inngest. Plexo uses a custom durable queue via `tasks` table + ULID + `CLAIM_TIMEOUT_SECONDS`.
- `apps/api/src/cron/`, `apps/api/src/cron-dispatch.ts`, `apps/api/src/routes/cron.ts` — cron registration.
- `apps/api/src/parallel-executor.ts` — fan-out work runner.
- `apps/api/src/redis-client.ts` — Redis backing.

### 2.7 Telemetry

- Prefix-based (`plexo_ops_*` tables in `public` schema), not a separate pgSchema.
- `apps/api/src/audit.ts`, `apps/api/src/event-tracker.ts`, `apps/api/src/health-monitor.ts`, `apps/api/src/delivery-tracker.ts` — emit points.
- Pino structured logs throughout.
- No PostHog/Sentry — confirmed compliant with the build prompt.

### 2.8 Better Auth

- `packages/db/src/auth/` — Better Auth schema.
- `apps/web/src/app/(auth)/`, `apps/api/src/routes/auth.ts` — surfaces.
- Pairing UX should plug here.

### 2.9 Pushd / deploy

- VPS at `REDACTED_VPS_IP` (auto-deploy daemon manages levio + plexo + pushd + command-center per user memory `service.md`).
- Plexo deploys via `docker-compose.yml` + the daemon. New Go sidecar requires a new compose service entry and a Dockerfile.

---

## 3. Levio internal inventory

### 3.1 IA / sidebar

- Top-level routes under `src/app/app/`: `email`, `today`, `week`, `month`, `settings`, `onboarding`. **No `messages` or `inbox` route exists.**
- `layout.tsx` is minimal (redirect logic). Sidebar component not surfaced by name in the audit window — actual nav lives deeper; flagged as an open question.
- New "Messages" surface for the Phase L integration would be a peer route to `email/`.

### 3.2 Email rendering / threading

- `src/app/app/email/` is the existing email surface.
- `src/app/api/email/` route group covers `send`, `search`, etc.
- Email pipeline + extraction documented in `LEVIO-AUDIT.md` §3.2 (pre-existing audit) and ADR-02 (`ADR-02-email-extraction-location.md`).
- Threading model: per the existing audit, email is grouped by Gmail thread ID. No unification with non-email channels exists today.

### 3.3 Notifications

- ADR-10 (`ADR-10-notification-dedup-table.md`) defines a dedup contract.
- Phase 1 of the Levio revamp shipped notification observability foundation. Phase 7 (in flight) closes the notification → user delivery loop.
- Reuse path exists for SMS/RCS notifications — same dedup table.

### 3.4 Search

- `src/app/api/search/` exists. Scoped to email + tasks + calendar today; would extend to messages in Phase L.

### 3.5 Pex consumer patterns

- Levio is **already** a sibling-app consumer of Plexo via the bridge contract:
  - **Inbound (Plexo → Levio):** Plexo's `factories/levio.ts` calls `LEVIO_INTERNAL_URL/api/plexo/data` with `Bearer ${PLEXO_SERVICE_KEY}`.
  - **Outbound events (Plexo → Levio):** `factories/levio.ts → emitToolEvent()` posts HMAC-signed JSON to `/api/plexo/events`.
  - **Levio side:** `src/app/api/plexo/{data,events,install,registry,tasks,workspace}/route.ts` — the contract endpoints.
- ADR-03 (`ADR-03-channel-ownership.md`) explicitly resolves channel ownership: **Plexo owns the wire, Levio owns the policy.** This decision is the load-bearing precedent for the Google Messages connector — it lands in the same seam.
- ADR-03 names a hypothetical SDK call `plexo.channel.dispatch({channel, recipientUserId, message, idempotencyKey, scopeOverrides?})` that the Levio team flagged as unconfirmed in Plexo. **It does not exist in `packages/sdk/`.** The Phase 2 contract work in this build can land it.

### 3.6 Inngest / durable work

- Inngest is the Levio convention (`src/lib/inngest/client.ts`, `functions.ts`). Phase L-side workflows (smart replies on demand, prioritization) plug here. Plexo side has no Inngest.

### 3.7 Plain-language copy

- Conventions inherited from `LEVIO-AUDIT.md` and `LEVIO-REVAMP-MASTER.md`. Copy is "Memory" and "Understanding" facing-side; never "embedding."
- Honor the same copy in the Plexo generic Channel viewer.

### 3.8 Deploy

- `nixpacks.toml` + Dockerfile + Pushd target. Deploy ritual at `LEVIO-CLAUDE.md`.
- Levio Phase 7 is mid-deploy — see `next-session.txt`. **Do not collide.**

---

## 4. Open questions for the operator

These cannot be decided unilaterally. Each is paired with the build prompt section it impacts.

**Architecture / one-way doors**

1. **Inngest in Plexo, yes or no?** (audit conflict 0.1) The build prompt assumes Inngest is a Plexo convention. It isn't. Choose: (a) the connector's durable jobs use Plexo's existing `tasks` queue + cron pattern; (b) this build introduces Inngest to Plexo as a new dep. Pick a, and the Levio Phase L side still uses Inngest as it does today.
2. **Schema namespace.** (audit conflict 0.3) Introduce true `pgSchema('plexo_gmessages')` or follow existing prefix convention with `gmessages_*` tables in `public`?
3. **Pex protocol scope.** (audit conflict 0.5, 0.11) Pex is locked at v0.4.0. Does the Channel subscription contract for sibling apps (Levio) require a 0.5 amendment, or can it ship inside the existing `/api/plexo/data` + `/api/plexo/events` HMAC contract extended with new event topics and a poll endpoint? Operator approval required before any 0.5 work.
4. **`plexo.channel.dispatch()` SDK method.** ADR-03 in Levio names this method as needed and unconfirmed. This build is the natural place to land it. Operator: yes/no on SDK addition.
5. **Connection vs Channel modeling for a paired phone.** Two clean options. (a) One `installedConnections` row of `registry_id='gmessages'` (credential blob), and one `channels` row referencing it (the rendered conversation surface). (b) Just one of those. Recommend (a). Confirm.

**Runtime / deployment**

6. **Go runtime sign-off.** Adding Go to the Plexo stack is the most consequential one-way door in this build. Confirm intent before Phase 1.
7. **Sidecar deployment shape.** PaaS service via Pushd, or first-class compose service in Plexo's main `docker-compose.yml`, or both? Affects how the Pushd auto-deploy daemon picks it up.
8. **Telemetry shim.** No Pushd SDK exists in Go. Either (a) write a thin Go shim posting to the existing Pushd HTTP ingest endpoint, or (b) the connector emits Pino-compatible JSON to stdout and Plexo Core's host process forwards. Recommend (a).

**UX / scope**

9. **Generic Channel viewer scope.** (audit conflict 0.6) Confirm minimum: thread list + message view + send composer. Anything else (reactions, edit indicator, attachment preview pipeline) requires explicit scope add.
10. **Pairing UI placement.** Inside `apps/web/src/app/app/connections/` (peer to existing connection setup screens) or a dedicated `connections/gmessages/pair` route?
11. **Phase numbering.** (audit conflict 0.7) Rename the Levio integration phase from "Phase 7" to **Phase L**, gated behind Levio's existing Phase 7 closeout. Confirm.

**Protocol risk**

12. **libgmessages version pin policy.** Pin to a specific tag (rebuild on bump) or track a release line? Operator preference.
13. **Failure-mode copy.** When Google rotates the protocol, what do users see? "Google Messages is updating, reconnect required" type copy needs an operator-approved string.

**Compliance / legal**

14. **AGPL implications.** Using `libgmessages` as a dependency in a Go service we ship as part of Plexo (which is also AGPL-3.0) is fine. Confirm there is no separate concern about reverse-engineered Google Messages traffic in the SaaS posture.
15. **Out-of-scope confirmations.** Confirm: no Matrix bridge, no iMessage, no Plexo Cloud-managed-LLM hooks, no PMC opt-in toggles. (Restated from build prompt.)

---

## 5. What this audit deliberately did not do

- Read the full `docs/pex/SPEC.md` (2416 lines). I read the TOC and the relevant sections only. If Phase 1 surfaces a §X reference outside the inventoried sections, re-audit.
- Read the full `apps/api/src/routes/telegram.ts` (1613 lines). I confirmed shape and the inbound-webhook pattern; the rest is for Phase 5 when the analog is built.
- Audit the `apps/android/` app. Out of scope per the build prompt.
- Audit the `apps/embeddings/` worker. Memory extraction pipeline reuses it but the connector does not invoke it directly.
- Audit the `apps/cli/`. Out of scope.

---

## 6. Self-generating handoff

Paste this single line into a fresh Claude Code session at `/home/user/dev/plexo` to resume:

> Resume `PLEXO-GMESSAGES` Phase 1. Read in order: `/home/user/dev/plexo/PLEXO-GMESSAGES-PHASE-0-AUDIT.md`, `/home/user/dev/plexo/plan.md`, `/home/user/dev/plexo/checklist.md`, `/home/user/dev/plexo/PLEXO-GMESSAGES-PROGRESS.md`, `/home/user/dev/plexo/adr/0001-gmessages-go-sidecar.md`. State: Phase 0 complete, awaiting operator answers to §4 open questions in the audit. Do not write code or schema. Next concrete step: convene the Phase 1 expert panel per the build prompt, surface conflicts, draft decision records, and produce `/home/user/dev/plexo/PLEXO-GMESSAGES-PHASE-1-DESIGN.md`. Stop at the Phase 1 one-way-door gate (Go runtime, Pex extensions, token storage, schema namespace).
