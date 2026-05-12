# PLEXO Google Messages connector — master plan

**Goal:** ship a first-party Google Messages channel inside Plexo (paired phone → SMS/MMS/RCS as canonical Plexo events), implemented as a Go sidecar importing `libgmessages`, with Levio's enriched messaging surface as the canonical first sibling-app consumer of the new Channel subscription contract.

**Owner:** operator + Claude Code.
**Repos in scope:** `/home/user/dev/plexo` (primary), `/home/user/dev/joeybuilt/levio` (Phase L only).
**Companion docs:** `PLEXO-GMESSAGES-PHASE-0-AUDIT.md` (findings + open questions), `checklist.md` (flat work list), `adr/0001-gmessages-go-sidecar.md` (pre-mortem), `PLEXO-GMESSAGES-PROGRESS.md` (status tracker per build prompt).

---

## Audit-stage expert panel (light)

Six named experts, one position each, at least one cross-conflict each. The deep Phase 1 panel (build prompt §Phase 1) follows after operator approval of this plan.

- **Mira (Protocol engineer)** — libgmessages drift is the dominant operational risk, not pairing. Re-pair UX is solvable; protocol decode-error counters as primary liveness probe is non-negotiable.
- **Jin (Distributed systems engineer)** — Single-process Go sidecar per Plexo instance is fine for v0; "one Go process per workspace" is premature. Run multi-tenant with strong per-session isolation and a session-scoped goroutine pool. Conflict with Yara: she wants per-tenant process boundary for blast-radius reasons.
- **Yara (Auth/security)** — A compromised connector instance must not exfil all tenants' message history. Either per-tenant process boundary, or per-session encryption keys never co-resident in memory. Conflict with Jin: he prefers single-process for ops simplicity.
- **Avi (Database architect)** — Add `gmessages` to `channelTypeEnum` and the `tasks.source` enum, then store paired-session blobs in `installedConnections.credentials` (encrypted). New tables only for pairing-state-machine and message dedupe — keep the canonical message store reusing the existing Plexo Core tables. Conflict with Sona: she wants a true `pgSchema` namespace.
- **Sona (Plexo UX)** — A generic Channel viewer in Plexo proper is non-negotiable. Without it, a non-Levio user pairs a phone they can't see. This is more important than Levio's enriched UX for v1. Conflict with Reza: he wants Plexo to ship without a viewer and let Levio be the only render path; faster shipping.
- **Reza (Product strategy)** — Levio is the AI-enriched experience. Let Plexo's view be utilitarian and shippable; over-investing in the generic viewer slows the AI-native moment. Conflict with Sona above.

**Surfaced conflicts (operator decides, do not silently merge):**
- **C1: Process isolation model.** Jin (single-process) vs Yara (per-tenant process). Operator decides: sidecar tenancy model.
- **C2: Schema namespace.** Avi (prefix in public) vs Sona (true `pgSchema`). Operator decides: namespace strategy. (See audit §0.3.)
- **C3: Generic viewer scope.** Sona (full minimum: list + view + send) vs Reza (defer entirely, Levio-first). Operator decides: viewer scope. (See audit §0.6.)

These three conflicts roll into the Phase 1 deep panel as anchor questions.

---

## Master phases

Phase numbering matches the build prompt with one disambiguation: "Phase 7 (Levio)" is renamed **Phase L** to avoid collision with Levio's in-flight Phase 7 deploy gate (`/home/user/dev/joeybuilt/levio/next-session.txt`). Operator confirms this in audit open question §11.

Each phase has: scope, dependencies, expected context budget (≤45% per phased-plan skill), subagents to spawn, exit criteria, sign-off gates.

### Phase 0 — Audit ✅ complete

- **Output:** `PLEXO-GMESSAGES-PHASE-0-AUDIT.md`, `plan.md`, `checklist.md`, `adr/0001-gmessages-go-sidecar.md`, `PLEXO-GMESSAGES-PROGRESS.md`.
- **Sign-off gate:** operator answers the 15 open questions in audit §4. **STOP.**

### Phase 1 — Expert panel + design + decision records ⚠ one-way doors

- **Scope:** convene the deep 8-expert panel from the build prompt; produce decision records covering Pex transport, token encryption-at-rest scheme, pairing-as-Connection-vs-Channel, libgmessages version pin policy, protocol-drift failure mode, connector identity copy, Plexo-vs-Levio surface split, generic Channel viewer scope, Pex Channel subscription contract.
- **Dependencies:** operator answers to Phase 0 open questions.
- **Context budget:** ≤40%. Spawn one Explore subagent per panelist for parallel position research.
- **Exit criteria:** `PLEXO-GMESSAGES-PHASE-1-DESIGN.md` checked in; ADRs `0002` through `~0010` written under `adr/`.
- **Sign-off gate (one-way doors):** operator explicitly approves (a) Go runtime in Plexo, (b) Pex protocol extensions or none, (c) token encryption scheme, (d) schema namespace. **STOP.**

### Phase 2 — Pex contract + schema migration ⚠ one-way door

- **Scope:** Drizzle migration for the Phase 1-decided schema; new `connectionsRegistry` row for `gmessages`; extend `channelTypeEnum`, `tasks.source`, `messageDeliveries.channel`. Pex Channel type definition for SMS/MMS/RCS messages. Pex Connection type for paired session. Pex Channel subscription contract with read/send/event-stream scopes (or HMAC-extension equivalent if Phase 1 stays inside 0.4.0). TS types exported for Node + Go consumption.
- **Dependencies:** Phase 1 sign-off.
- **Context budget:** ≤35%.
- **Subagents:** general-purpose for the migration script + types; Explore for cross-reference verification on consumers.
- **Exit criteria:** migration runs clean against dev DB; types compile in `packages/sdk` and produce a Go-consumable JSON schema or hand-written Go structs.
- **Sign-off gate:** operator confirms migration ran clean against dev. **STOP.**

### Phase 3 — Go connector skeleton

- **Scope:** new repo dir (probably `apps/gmessages/` per Plexo monorepo conventions, confirm in Phase 1); `go.mod` with libgmessages pinned; Pex client (outbound events, inbound commands) over HTTP/SSE or WebSocket per Phase 1 transport decision; health endpoint; telemetry shim into Pushd; env-only config; failing integration test stub; `make` or `task` dev target.
- **Dependencies:** Phase 2 contract committed.
- **Context budget:** ≤40%.
- **Subagents:** general-purpose for `go.mod` + handler scaffolding.
- **Exit criteria:** sidecar boots locally, hits `/health` on the dev Plexo Core, emits one synthetic event end-to-end. No real pairing yet.

### Phase 4 — Pairing UI + Connection lifecycle + generic Channel viewer

- **Scope:** pairing UI in Plexo's Next.js app; deep-link contract documented for sibling apps; full Connection state machine (create / active / refreshing / expired / revoked / errored) with telemetry on transitions; durable session-refresh job (queue strategy per Phase 1 decision on Inngest-vs-Plexo-tasks, audit §0.1); stale-session detector (notification per ADR-10 idiom); generic Channel viewer (thread list + message view + send composer) in Plexo proper.
- **Dependencies:** Phase 3 skeleton + Phase 2 contract.
- **Context budget:** ≤45% — split if needed.
- **Subagents:** general-purpose for UI; Explore for state-machine reference; consider parallel general-purpose for viewer + lifecycle.
- **Exit criteria:** pair a real phone end-to-end in dev; messages render in Plexo's viewer; offline state surfaces correctly.

### Phase 5 — Message normalization + ingestion

- **Scope:** inbound libgmessages event → normalized Pex event → Plexo Core ingestion → existing `reflectAndPromote` memory pipeline → standard channel storage; outbound Plexo Core → Pex command → libgmessages send (idempotency keyed on message ID); attachments fetched, decrypted (libgmessages AES-CTR/GCM), re-uploaded to Plexo's existing attachment store; read receipts + typing indicators bidirectional where libgmessages supports; restart-mid-stream dedupe.
- **Dependencies:** Phase 4 lifecycle live.
- **Context budget:** ≤45%.
- **Subagents:** general-purpose for ingest path + tests; Explore for memory-pipeline integration points.
- **Exit criteria:** real SMS, MMS, and RCS messages round-trip through Plexo Core in dev. RCS feature parity decision (rich cards, suggested replies — in scope or deferred) honored per Phase 1 decision.

### Phase 6 — Operations ⚠ one-way door (first prod deploy) — **deployed 2026-05-06**

- **Scope (as built):** platform compose service definition for the Go sidecar (joeybuilt VPS, not Pushd as originally drafted); health probes wired to telemetry tables; Inngest-cron stale-session monitor (queued — Inngest service not yet in platform compose); runbook entries for session-expired / libgmessages bump / protocol drift / restart loop; README in connector dir.
- **Dependencies:** Phase 5 ingest hardened.
- **Context budget:** ≤35%.
- **Subagents:** general-purpose for compose + ops doc + runbook.
- **Exit criteria + ship gate:** all Plexo tests pass; `go vet`/`go test` clean; Node typecheck clean; **hub build clean** (added 2026-05-06 after a Turbopack regression slipped through); no unintentional uncommitted changes; build succeeds end-to-end; push target + deploy target confirmed.
- **Sign-off gate:** operator-witnessed §7.3 phone-pair smoke green (deferred to operator's convenience post-deploy).

### Phase L — Levio integration ⚠ one-way door (first Levio prod deploy with messaging)

- **Scope:** Levio subscribes to user's Google Messages Channel via the Phase 2 contract; new "Messages" surface in Levio's IA per Phase 1 decision; threaded conversation list + message view + send composer (Levio-enriched delta over Plexo's baseline viewer); "Connect Google Messages" CTA deep-links to Plexo's pairing flow; "Phone offline" status sourced from Plexo Core; AI enrichment as Pex agent calls (smart replies, prioritization, summarization, unified search) — zero local model creds in Levio; notification integration via existing patterns + ADR-10 dedup.
- **Dependencies:** Phase 6 deployed and stable; Levio's own in-flight Phase 7 closed first.
- **Context budget:** ≤45%.
- **Subagents:** general-purpose for Levio routes/UI; Explore for Levio IA decisions.
- **Exit criteria:** Levio ship gate (tests, typecheck, build) clean; Levio deploy target confirmed; one real paired Google Messages thread visible in Levio with smart-reply enrichment.
- **Sign-off gate:** operator approves first Levio deploy with the new surface. **STOP.**

### Phase O1 — Observability: Logging Completeness + External Error Sink

Goal: ensure every API and client error is captured, visible, and
actionable regardless of workspace analytics toggle state.

Scope:
- **Dark route cleanup:** `apps/api/src/routes/code.ts` (6 catch
  blocks, zero logging) and `apps/api/src/routes/sse.ts` (1 silent
  catch). Add `import { logger }` and replace bare catches with
  `logger.warn`/`logger.error` at appropriate severity.
- **Intentional-silence annotation:** any `catch {}` in sse-emitter.ts,
  extensions.ts etc. that is genuinely silent by design gets an
  explanatory comment so future contributors don't add logging
  inadvertently.
- **External error sink (Sentry):** add `@sentry/node` to the API;
  `@sentry/nextjs` to apps/web. DSN via `SENTRY_DSN` env var.
  `beforeSend` scrubs the `notes` field (pattern `/notes/i`) from
  breadcrumbs. Port the existing `IGNORE_ERRORS` list from
  `trackError()` into Sentry `beforeSend` to suppress noise.
  Log a startup warning if `SENTRY_DSN` is undefined.
- **Client-side capture:** wire `apps/web/src/instrumentation.ts`
  (currently empty stub) and `apps/web/src/global-error.tsx` to the
  Sentry Next.js SDK.

ADR: 0007.

Design decisions:
- Sentry over Logtail (Logtail = log aggregator, no client-side SDK).
- `notes` field scrubbed by pattern not literal for forward-safety.
- `trackError()` already logs via pino regardless of relay; Sentry
  adds a permanent external fallback.

⚠ Operator sign-off required: approve Sentry as external service +
supply `SENTRY_DSN` env var before code lands.

Deps: none.
Context budget: ≤20%.
Subagents: one write agent for API changes, one for web changes (parallel).
Exit: Sentry receives a test error from both API and web app; code.ts
and sse.ts catch blocks emit structured log lines; typecheck clean;
commit + push + deploy.

---

## Authorization gates (carry from build prompt)

Hard stops; do not proceed without explicit operator sign-off:

1. Phase 0 → 1 (after audit review).
2. Adding Go as a runtime to the Plexo stack (Phase 1).
3. Pex protocol additions or extensions (Phase 1).
4. Token encryption scheme (Phase 1).
5. Schema migration execution (Phase 2).
6. First production deploy (Phase 6) — **partially closed 2026-05-06**: deploy executed cleanly to the joeybuilt VPS via auto-deploy daemon + manual platform-compose edit for the gmessages sidecar; only the operator-witnessed §7.3 phone-pair smoke remains.
7. First Levio production deploy with the new messaging surface (Phase L).
8. Any dependency add beyond `libgmessages` and its transitive deps.
9. Any change to existing Pex Connector contracts that other connectors depend on.

---

## Out of scope (carry from build prompt)

- Matrix-bridge route for self-hosters.
- iMessage on macOS.
- People's Model Commons opt-in for message data.

---

## Skill-mode policy

Phased-plan skill rules apply: ≤45% context per phase, subagent for any 20K+-token chunk, three-file handoff at end of every session (`plan.md` + `checklist.md` + `next-session.txt`), audit-first when scope changes, expert-panel methodology when unsure. Per-phase docs (`PLEXO-GMESSAGES-PHASE-N-*.md`) double as the build prompt's required outputs.
