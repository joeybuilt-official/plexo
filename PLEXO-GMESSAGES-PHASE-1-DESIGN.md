# PLEXO Google Messages connector — Phase 1 design

**Status:** awaiting Phase 1 sign-off (one-way doors). Operator pre-authorized: Inngest if perf-justified + silent + setup-installable; Pex protocol modification "as needed per best practices"; schema namespace delegated to panel; Go runtime + paired-session pattern.
**Date:** 2026-05-05
**Inputs:** `PLEXO-GMESSAGES-PHASE-0-AUDIT.md`, `adr/0001-gmessages-go-sidecar.md`, OSS benchmark in audit §1.

This document holds the deep expert panel, the decision register, and the Phase 1 outputs the build prompt requires. Heavy decisions are split into ADR files (`adr/0002`–`adr/0006`); lighter decisions live inline below the panel.

---

## 1. Expert panel

Eight panelists. Each speaks from their discipline. Conflicts surfaced explicitly under "Cross-conflicts."

### 1.1 Mira — Protocol engineer (libgmessages)

The library is the fragile surface. mautrix-gmessages issue #3 documents that `ping` reports a healthy session while inbound is dead for days. The only true liveness probe is **decode-error counters and inbound-message-flow heartbeat** — not the library's session-active flag. Any version bump to libgmessages must roll out staged (5% canary, 24h watch on decode-error rate, then broad rollout). Pin to a specific git tag, not a branch. Update cadence: monthly minimum, faster on observed drift. RCS feature parity is a moving target; ship SMS+MMS with RCS receipts/typing on day one and gate rich-cards/suggested-replies behind a feature flag — those break most often when Google rotates.

**Conflict with Jin (DistSys):** Jin treats the connector as a generic event source. I treat it as a black box that lies about its own health. We disagree on the heartbeat strategy: he wants library-level health probes (cheaper); I want flow-level heartbeats (expensive, accurate).

### 1.2 Jin — Distributed systems engineer

Single Go process, multi-tenant inside, with per-session goroutines and a session-scoped key derivation that prevents cross-tenant memory aliasing. Per-tenant process boundaries are premature for v0 — a workspace count below 10k doesn't justify it. Pex transport: **HTTP/SSE for inbound** (events) and **plain HTTP POST for outbound** (commands). WebSocket adds reconnect logic without buying anything Plexo doesn't already need. gRPC introduces protobuf codegen across the polyglot boundary — too heavy for the first cut. Backpressure: Plexo Core is the slow side; the connector buffers inbound events with a bounded ring and drops on overflow with a telemetry burst (this is acceptable because libgmessages will replay missed events on next sync).

**Conflict with Yara (Auth/Security):** she wants per-tenant process boundary as the only acceptable isolation. I argue per-session goroutine + key derivation is sufficient at our scale and we revisit if we cross 10k workspaces or have a tenant-isolation incident.

### 1.3 Avi — Database architect

Two pieces of state: (a) a paired Google session — credential-grade — belongs in `installedConnections.credentials` reusing the existing AES-256-GCM crypto-util pattern; (b) the conversational/dedupe state belongs in **its own pgSchema** (`plexo_gmessages`) — not because monolithic-public is broken, but because this is the first connector in Plexo with a non-trivial private schema (pairing-state-machine, message dedupe ring, RCS feature-flag cache). True namespacing is a one-time tax at Phase 2 that pays back when Phase 6 adds a second sidecar (Signal, WhatsApp). Add `gmessages` to `channelTypeEnum`, `tasks.source`, and `messageDeliveries.channel` — those are public-shared. Dedupe key: `(workspace_id, gmessages_message_id)`. Do not key on Google's conversation ID alone — RCS group chats can rotate it.

**Conflict with Sona (Plexo UX):** Sona wants the UI to treat each paired phone as a single Connection entry. I want a Connection (credential) + Channel (rendered surface) pair to keep the data model clean. We disagree on whether a user sees one row or two in the connections list.

### 1.4 Yara — Auth/security specialist

Better Auth handles the Plexo user session; the paired Google session is a separate, longer-lived credential with phone-level read/write power. Blast radius of a compromised connector instance must be: one workspace's messages compromised, **never all**. That requires per-workspace key derivation (already supported by `crypto-util.ts`) and a per-session in-memory boundary that does not leak across goroutines. I'd prefer per-tenant process boundary, but I'll accept Jin's per-session-goroutine model if (a) session keys are zeroed on session end via `runtime.KeepAlive` + explicit overwrite, (b) panic-isolation kills only the offending session goroutine, never the process, and (c) structured logging redacts session blobs at compile time, not runtime regex. Pairing UX: QR scan via Plexo's web app, with Better Auth-gated session, returning the Google session blob encrypted server-side before storage. Never let the QR-scan response touch unencrypted disk.

**Conflict with Jin** (above) on tenancy. **Conflict with Reza (Product):** he wants minimal user friction in pairing; I want explicit "you are pairing your phone with Plexo, which can read all your SMS/RCS" consent copy with a checkbox, even if it adds a step.

### 1.5 Sona — Plexo UX

The generic Channel viewer is non-negotiable. Without it, a non-Levio user pairs a phone they cannot see — the product is broken on first run. Minimum scope: thread list (most-recent-first, unread badge), message view per thread (text + attachment thumbnails + timestamps), send composer (plain text + attach). Reactions, edit indicators, smart replies, prioritization — all Levio-enriched, not in the Plexo viewer. Pairing UI: dedicated route `app/connections/gmessages/pair` with QR rendering, status polling, success state that deep-links back to the originating app (Levio or Plexo's connections page). Connector identity in the connections list: "Google Messages" name, `gmessages` slug, official Google Messages logo (Wikimedia public-domain SVG). Plain-language copy throughout: "Pair your phone," "Phone is offline," "Reconnect."

**Conflict with Reza:** he wants the Plexo viewer deferred or stubbed. I argue ship it minimal in Phase 4. **Conflict with Avi:** I want one entry in the Connections UI per paired phone; he wants Connection + Channel as two entries. Compromise: one row in the Connections UI (workspace-facing), backed by two database entities (data model).

### 1.6 Lena — Levio product/UX designer

In Levio's IA, messaging lives as a peer to `email/` — new top-level route `app/messages` (or unified `app/inbox` if the Phase L work also unifies email + SMS, which I'd argue against in v1). SMS/RCS does not coexist with email in the threading model in v1 — each owns its own viewer; cross-channel unification is a Phase L+1 concern. Smart-reply surface: chip suggestions above the composer, identical pattern to Levio's existing email reply. "Connect Google Messages" CTA in onboarding + settings, deep-links to Plexo pairing flow, returns to `app/messages` on completion. Levio-side onboarding for users who haven't paired in Plexo yet: the same CTA — Levio never reimplements pairing, just deep-links. Phone-offline status surfaced inline in the messages route header, sourced from Plexo Core's Connection state via the existing `/api/plexo/data` HMAC contract.

**Conflict with Sona:** Sona's viewer is a baseline; mine is the enriched delta. I want clear visual distinction so users on both surfaces don't see "the same thing twice." Sona wants visual continuity. We disagree on whether Plexo's viewer and Levio's viewer should share components.

### 1.7 Diego — DevOps engineer

Two new things in the deploy graph: (a) a Go binary, (b) Inngest if Phase 1 confirms the install. Go: `apps/gmessages/` with a multi-stage Dockerfile producing a static binary; new compose service in Plexo's `docker-compose.yml` plus a Coolify config under Pushd's auto-deploy daemon scope (`service.md`). Health probe at `/health` polled every 10s; restart policy `on-failure:5` with exponential backoff. Telemetry: Go shim posting Pino-equivalent JSON to Plexo's existing audit ingest endpoint (HTTP POST with HMAC) — no new Pushd Go SDK. Inngest install: it's a Node service with Postgres-backed durability; install via npm and run alongside the API service in compose. UI surface: zero — Inngest dashboard stays internal-only behind VPN/SSH tunnel. Setup wizard adds Inngest config to `.env.example` and the deploy script bootstraps it. **This honors the operator's "silent + setup-installable" mandate.**

**Conflict with Avi:** he wants a true `pgSchema` for the connector; I want fewer schemas because every new pgSchema means a new Drizzle migration tree and a new search_path branch in the deploy. I'll concede if Phase 2 absorbs the migration tax in one go.

### 1.8 Reza — Product strategist (Plexo + Levio)

Binding principle: zero AI in the connector, zero AI in Levio's messaging surface — every smart-reply / prioritization / summarization call goes through Plexo Core agent endpoints. Levio invokes; Plexo Core executes. Identity copy: this is "Google Messages" first, "the Plexo Google Messages connector" never. The user pairs a phone, not an extension. Plexo-baseline-vs-Levio-enriched: ship both. Non-Levio users get a complete-and-usable Google Messages experience inside Plexo. Levio users get smart replies, prioritization, unified search. The split is real, not aspirational. Pex Channel subscription contract: Levio is the canonical first consumer, but the contract is general — design for Signal, WhatsApp, future channels using the same shape. **My one strong push: the Pex SPEC stays at 0.4.0** despite the operator's authorization to amend. Channel subscription is host-side REST + new event topics, not new envelope types — that fits inside 0.4.0. Save the version bump for a real protocol change.

**Conflict with Sona:** I want the Plexo viewer deferred to a stub and the engineering investment funneled into Levio's enriched surface; she wants the Plexo viewer shipped as a real product. **Operator already weighed in on this in Phase 0 audit §0.6 — Sona wins. Generic viewer ships in Phase 4.**

---

## 2. Cross-conflict summary (operator-decided)

| ID | Conflict | Resolution |
|---|---|---|
| C1 | Jin (single-process multi-tenant) vs Yara (per-tenant process). | **Single-process multi-tenant for v0**, with Yara's three guarantees (zeroed keys, panic isolation, compile-time redaction) as ADR-0004 invariants. Revisit at 10k workspaces or any cross-tenant incident. |
| C2 | Avi (true `pgSchema`) vs Diego (prefix in public, fewer schemas). | **True `pgSchema('plexo_gmessages')`** for non-trivial private state. Public-shared enums (`channelTypeEnum`, `tasks.source`, `messageDeliveries.channel`) extend the existing public tables. Phase 2 absorbs the migration tax. ADR-0003. |
| C3 | Sona (ship generic viewer) vs Reza (defer / Levio-only). | **Sona wins.** Generic viewer ships in Phase 4 with the minimum scope she defined: thread list + message view + send composer. ADR-0005. |
| C4 | Avi (Connection + Channel as two entities) vs Sona (one Connections list row). | **Both true at different layers.** Database: Connection (credentials) + Channel (rendered surface) — two rows, FK linked. UI: Connections list collapses to one row per paired phone; the user never sees the Channel-as-separate-entity. ADR-0003. |
| C5 | Mira (flow heartbeat) vs Jin (library health probe). | **Both, layered.** Library health probe runs every 10s (cheap, fast-fail on process death). Flow heartbeat — last-inbound-timestamp + decode-error counter — runs every 60s and is the truth for "is this session actually working." Plexo Core's stale-session monitor reads the flow heartbeat. ADR-0004. |
| C6 | Lena (Plexo and Levio viewers visually distinct) vs Sona (visual continuity). | **Levio's viewer is visually distinct** — it's the Levio brand surface. They share data shape (Pex Channel envelope) but not components. ADR-0005. |
| C7 | Reza (Pex stays at 0.4.0) vs operator authorization to amend "as needed per best practices." | **Reza wins on best-practices grounds.** Channel subscription contract fits inside 0.4.0 as host-side REST + event topics. Pex SPEC unchanged. ADR-0002. Operator's authorization remains available if Phase 5 surfaces a genuine protocol-spec gap. |
| C8 | Yara (consent-screen friction) vs Reza (minimal-friction onboarding). | **Yara wins — single consent screen** with checkbox before pairing. Copy: "Pairing connects your Google Messages to Plexo. Plexo and authorized apps will be able to read and send SMS, MMS, and RCS messages on your behalf." ADR-0005 captures copy. |

---

## 3. Decision register

Heavier decisions are in `adr/`; smaller ones are inline.

### 3.1 Pex Channel subscription contract — **ADR-0002**

Host-side REST endpoints on Plexo Core under `/api/plexo/channels/...`, authenticated with the existing `PLEXO_SERVICE_KEY` HMAC pattern. Sibling apps subscribe; Plexo streams events back via SSE on the same auth. Pex SPEC stays at 0.4.0.

### 3.2 Schema + token encryption — **ADR-0003**

`pgSchema('plexo_gmessages')` with three private tables (pairing state, message dedupe, RCS feature-flag cache). Public-shared enums extended in place. Token encryption reuses `crypto-util.ts` AES-256-GCM, workspace-scoped. Connection (credential row in `installed_connections`) + Channel (rendered surface row in `channels`), FK linked, UI-collapsed to one row.

### 3.3 Sidecar tenancy + liveness — **ADR-0004**

Single Go process, multi-tenant. Per-session goroutine with key derivation from workspace ID + session ID. Three invariants from Yara: keys zeroed on session end, panic isolation per session goroutine, compile-time-redacted structured logs. Layered health: 10s library probe + 60s flow heartbeat (last-inbound + decode-error counter).

### 3.4 Plexo viewer + pairing UX — **ADR-0005**

Generic Channel viewer ships in Phase 4 with thread list + message view + send composer. Pairing UI at `app/connections/gmessages/pair`. Single consent screen with checkbox before QR scan. Plain-language copy. Levio's viewer is visually distinct, shares only the Pex Channel envelope shape.

### 3.5 Inngest install — **ADR-0006**

Add Inngest to Plexo as a Node-side dep. Install via pnpm; run in compose alongside the API service. Postgres-backed durability (no new infra). UI surface: zero — dashboard internal-only. `.env.example` and deploy script bootstrap config. Justification: durable session refresh + stale-session cron + Levio Phase L workflow trigger all benefit from Inngest's idempotency + retry semantics; Plexo's `tasks` queue does not natively support cron + workflow chaining. Phase 4 + L use Inngest; Phase 5 ingestion uses both (raw events through `tasks` for ordering, derived workflows through Inngest).

### 3.6 libgmessages version pin (inline)

Pin to a specific git tag in `go.mod` (not a branch, not `latest`). Bump cadence: monthly minimum, faster on observed drift. Bump procedure: 5% canary for 24h with decode-error counter watch, then broad rollout. Runbook entry in Phase 6.

### 3.7 Connector identity (inline)

| Field | Value |
|---|---|
| Display name | Google Messages |
| Slug | `gmessages` |
| Category | `messaging` |
| Description | Read and send SMS, MMS, and RCS messages from your phone. |
| Logo | Google Messages public-domain SVG (Wikimedia Commons). |
| Auth type | `paired_session` (new value in `authTypeEnum`) |
| `is_core` | `true` |

### 3.8 Pairing model (inline)

A paired phone produces **two database entities**:

- **`installedConnections`** row, `registry_id='gmessages'` — stores encrypted libgmessages session blob, refresh metadata, last-verified timestamp.
- **`channels`** row, `type='gmessages'`, `config={connectionId: <fk>}` — the rendered surface that the viewer + Levio subscribe to.

UI shows **one row** in the connections list per paired phone (the Connection); the Channel is implicit. Internal data model keeps the two distinct so multiple Channels could later attach to one Connection (e.g., a "work phone" pair surfacing two separate viewers).

### 3.9 Pex transport (inline)

- **Plexo Core → connector (commands):** plain HTTPS POST with HMAC body sig.
- **Connector → Plexo Core (events):** HTTPS POST per event with HMAC body sig (simple, ordered per session).
- **Sibling app → Plexo Core (subscription stream):** SSE over HTTPS, HMAC-authenticated.
- **No WebSocket, no gRPC** in v1.

### 3.10 Failure-mode copy (inline)

| State | Copy |
|---|---|
| Session expired | "Your phone connection needs to be reconnected. Reconnect now." |
| Inbound silent > 24h | "We haven't seen messages from your phone in a while. Check the Google Messages app on your phone is online, or reconnect." |
| Google protocol drift detected | "Google Messages is updating. Reconnecting your phone may take a few minutes." |
| Connector restart | (no user-facing copy — internal only) |

### 3.11 Plexo vs Levio surface split (inline)

- **Plexo proper:** pairing UI, connections management, generic Channel viewer (baseline experience).
- **Levio:** enriched Messages surface (smart replies, prioritization, unified search via Plexo Core agents). Levio deep-links to Plexo for pairing — never reimplements.
- **Both surfaces** subscribe to the same Pex Channel via the contract in §3.1 / ADR-0002.

---

## 4. Phase 2 implementation outline

The build prompt requires a phase-by-phase outline 2–6 in this document. The bulk lives in `plan.md` and `checklist.md`. Phase 2 specifics, refined post-panel:

1. Drizzle migration adds `pgSchema('plexo_gmessages')` with three tables: `paired_sessions` (pairing state machine), `message_dedupe` (dedupe ring), `rcs_feature_cache` (per-thread RCS capability snapshot).
2. Migration extends `channelTypeEnum` with `gmessages`, `tasks.source` enum with `gmessages`, `messageDeliveries.channel` text accepts `gmessages`.
3. Migration extends `authTypeEnum` with `paired_session`.
4. `connectionsRegistry` seed row for `gmessages` per §3.7.
5. New TS types in `packages/sdk/src/types/` for Pex Channel envelope (text, attachment ref, status update) and Pex Connection (paired session metadata). Stable, versioned by `pex_version: '0.4.0'` in every envelope.
6. New REST routes on `apps/api/src/routes/channels-subscription.ts` implementing the contract per ADR-0002. SSE event stream per ADR-0002.
7. New `apps/api/src/routes/channels-gmessages.ts` for connector-facing inbound events + outbound command commands.
8. Go-consumable type representation: hand-written Go structs in `apps/gmessages/internal/pex/` mirroring the TS types, with a CI compat-test that round-trips fixtures across the boundary.
9. Inngest setup: `packages/queue` adds Inngest client, compose adds Inngest service, deploy script bootstraps. Setup wizard updated.
10. Phase 2 ship gate: dev DB migration clean, Inngest healthy in dev compose, TS + Go types compile.

Phases 3–6 + L outlines remain as in `plan.md`. No structural changes; specifics will be refined at each phase entry.

---

## 5. Self-generating handoff

> Resume `PLEXO-GMESSAGES` Phase 2. Read in order: `/home/dustin/dev/plexo/PLEXO-GMESSAGES-PHASE-1-DESIGN.md`, `/home/dustin/dev/plexo/adr/0002-pex-channel-subscription.md`, `/home/dustin/dev/plexo/adr/0003-schema-and-encryption.md`, `/home/dustin/dev/plexo/adr/0004-sidecar-tenancy.md`, `/home/dustin/dev/plexo/adr/0005-plexo-viewer-and-pairing.md`, `/home/dustin/dev/plexo/adr/0006-inngest-install.md`, `/home/dustin/dev/plexo/plan.md`, `/home/dustin/dev/plexo/checklist.md`. State: Phase 1 complete and signed off. Operator authorized: Go runtime, Pex 0.4.0 stable (no SPEC bump), token encryption via `crypto-util.ts`, schema namespace `plexo_gmessages`, Inngest install. Next concrete step: write Drizzle migration extending `channelTypeEnum`/`authTypeEnum`/`tasks.source` + creating `pgSchema('plexo_gmessages')` with three tables; seed `connectionsRegistry` row for `gmessages`; add Pex Channel + Connection TS types in `packages/sdk`; install Inngest npm dep + compose service. Stop at Phase 2 close-out gate (operator confirms migration ran clean on dev DB).
