# Plexo — Architecture & Structure Audit Findings

Audited 2026-06-11 against source at `/workspace/plexo` `main` (turbo+pnpm monorepo: 8 apps, 10 packages, 1 service; 107 route files / 384 handlers; 74 tables; 136 migrations; 239 env vars). Method: six-expert panel (ARCH, DOMAIN, SEC, DATA, SCALE, OPS) per the Clean-Architecture doctrine, verified against running code where claimed. Tags: **[verified]** read the code directly, **[evidence]** found by grounded subagent sweep with file:line.

Scope note: this is the **architecture** audit. The pre-existing `audit-findings.md` is the separate `apps/web` UI/UX audit — not superseded by this file.

> **Fixes applied (session 1, code-only / non-gated):**
> - **[P2] Invite-accept now atomic** — wrapped member-seat + invite-consume in `db.transaction`, invite-consume guarded by `isNull(usedAt)` (closes double-accept race). `members.ts:329`.
> - **[P2] Profile-registration N+1 removed** — N sequential extension upserts → one batched `insert(...).values([])` with `excluded.*` conflict update. `profiles.ts:121`.
> - **[P2] `GET /nodes` paginated** — added `limit` (cap 500, default 200) + `offset` + real `total` count. `nodes.ts:31`.
>
> **Fixes applied (session 2, operator-authorized gated items):**
> - **[P1] A1 — hot-path indexes APPLIED to prod** — `0136_hotpath_indexes.sql` (5 indexes) created `CONCURRENTLY` on prod `plexo` (NAS postgres), all `indisvalid=t`. Verified: by-session `session_logs` lookup went from a 50,616-cost Parallel Seq Scan (2.43M rows, zero prior secondary indexes) → 8.45-cost Index Scan. Schema `index()` defs added to match.
> - **[P1] A4 — `dev-secret` fallback removed** — `router.ts:116` now fails closed (throws if `PLEXO_SIGNING_SECRET` unset) instead of signing with a public constant.
> - **[P1] A2 — service-key IDOR bound (code; deploy-gated)** — `agents-run.ts` now checks `loadGrantedProfile(workspace, appId)` against `getEnforcementMode()`: rejects ungranted dispatch under `enforce`, logs-and-allows under `monitor`/`off`. Prod has **0** `workspace_app_grants` rows (pre-rollout), so hard-enforce would have caused an outage — fix is rollout-safe and closes the IDOR operationally once grants are seeded + `PROFILE_ENFORCEMENT_MODE=enforce`.
> - **[P1] B1 — repository boundary scaffolded** — `apps/api/src/repositories/nodes.repository.ts` owns all `nodes`/`node_trust` persistence; `nodes.ts` fully migrated off direct `db` (proof of the per-aggregate pattern to replicate across the other ~81 route files).
> Verified: api + agent typecheck clean (pre-existing `vision.ts:255` parse error unrelated, untouched); tests 30/30.
> **Not yet deployed** — A2/A4/B1 code changes need an api build+recreate to take effect (deploy is a separate gate). A1 is already live (DB-only).
> Remaining open: A3, A5, A6 (gated) + B2–B10 (refactors).

Severity: **P0** exploitable hole / data-integrity loss / scaling cliff already hit · **P1** Dependency-Rule violation in core path, ANY SEC finding, missing transaction, N+1/missing-index on hot path · **P2** coupling/cohesion debt, observability gaps · **P3** ceremony, polish, docs. SEC findings cannot rank below P1 (veto).

---

## P1 — Security

### [P1] Cross-tenant agent dispatch — `X-User-Id` is unbound from the authenticated principal
Expert(s): SEC
Principle: OWASP A01 Broken Access Control (confused deputy / IDOR)
Location: `apps/api/src/routes/agents-run.ts:23-77`; `apps/api/src/middleware/auth.ts:91-106`
Evidence: **[verified]** `requireAuth` accepts `Authorization: Bearer <PLEXO_SERVICE_KEY>` + `X-App-Id` (`auth.ts:91`) and stamps `serviceContext.userId` straight from the `X-User-Id` header (`:100-103`) with **no check that the service key is authorized to act for that user**. The handler then resolves the target workspace purely from that header — `where(eq(workspaces.ownerId, userId))` (`agents-run.ts:52`) — and enqueues an `automation` task into it (`:60`). Any holder of the shared service key can set `X-User-Id` to any UUID and execute agent tasks in that user's workspace, using the victim's AI creds and connections.
Blast radius: full cross-tenant task execution. Bounded today only by service-key secrecy (trusted-app boundary), so not unauthenticated — hence P1 not P0 — but it is a one-secret-away total-tenancy breach.
Fix approach: bind each `PLEXO_SERVICE_KEY` / `X-App-Id` to the set of users/workspaces it may act for (per-app grant table already exists — `workspace_app_grants`, migration 0134). Reject `X-User-Id` not covered by a grant. Incremental: add the grant check in `tryAppServiceKeyAuth` / the handler before dispatch.
Door: two-way

### [P1] Single static shared service key — no per-app scoping, no rotation (root cause)
Expert(s): SEC, OPS
Principle: OWASP A07 / least privilege; 12-Factor III (config)
Location: `apps/api/src/middleware/auth.ts:40,92`; `packages/agent/src/tools/workspace-tools.ts:284`
Evidence: **[verified]** one `PLEXO_SERVICE_KEY` env value is the trust anchor for *all* app-to-Plexo calls (Levio, Fylo, Fonto, …) and the internal SSR path. It is a long-lived bearer with no per-app derivation, no rotation mechanism, and (see above) no per-user binding. It lives in many app `.env`s across the fleet.
Blast radius: this is the single root behind the IDOR above — leak from any one consumer app = cross-tenant compromise of all of Plexo. Widest one-way door in the system if it leaks.
Fix approach: issue per-app keys (or signed, scoped, expiring tokens) and verify the app identity → capability mapping server-side; add rotation. Strangler: introduce per-app keys alongside the shared key, migrate consumers, retire the shared key last.
Door: two-way (migration), but a leak is one-way

### [P1] `PLEXO_SIGNING_SECRET` falls back to the constant `'dev-secret'`
Expert(s): SEC
Principle: OWASP A02 Cryptographic Failures
Location: `packages/agent/src/providers/router.ts:116`
Evidence: **[verified]** `const signingSecret = process.env.PLEXO_SIGNING_SECRET || 'dev-secret'`. In the managed-proxy inference path (Mode 3), if the env var is unset in prod the request envelope to `proxy.plexo.ai` is HMAC-signed with a publicly-known string — forgeable. Unlike the sibling `PLEXO_API_KEY || ''` / `PLEXO_SERVICE_KEY || ''` fallbacks (which fail **closed** to empty), this one fails **open** to a known value.
Blast radius: forged signed inference requests against the managed proxy. Only affects deployments using the Plexo-managed key pool; self-host BYO-key path unaffected.
Fix approach: remove the literal default; assert `PLEXO_SIGNING_SECRET` present at boot (fail to start) when the managed-proxy path is reachable. Audit the `|| ''` secret fallbacks for the same boot-time assertion.
Door: two-way

---

## P1 — Architecture / Data / Scale (core paths)

### [P1] No persistence boundary — drizzle is welded to the HTTP layer
Expert(s): ARCH, DATA
Principle: Dependency Rule / DIP; boundary integrity
Location: 82 of 103 route files `import { db } from '@plexo/db'` and call raw drizzle verbs — e.g. `apps/api/src/routes/tasks.ts:25,182,307`; `connections.ts` (24 sites); `auth.ts` (18). Zero repository abstractions exist (`rg 'interface \w+Repository'` = 0).
Evidence: **[evidence]** data access is scattered across the controller layer; the database cannot be swapped, sharded, or wrapped (caching, read-replica routing, tenancy guards) without editing ~82 files.
Blast radius: every cross-cutting data concern (tenant scoping, caching, read replicas, query budgeting) is un-implementable in one place. This is the structural reason several other findings (missing tenant scope, N+1, pool pressure) recur per-handler instead of being solved once.
Fix approach: strangler — introduce a thin repository/data-access module per aggregate (tasks, channels, memory, members), route new handlers through it, migrate old callers incrementally, delete direct `db.` imports from `routes/` last. Do **not** big-bang; do **not** build four layers of ceremony — one repository module per aggregate, no more.
Door: two-way

### [P1] Business invariants live in route handlers — anemic domain model
Expert(s): ARCH, DOMAIN
Principle: SRP; DDD (rich aggregate owns its rules)
Location: `apps/api/src/routes/tasks.ts:109-129` (field/UUID/enum/priority validation inline); `:317` (task state machine — `NOT_CANCELLABLE`, "already ${status}" — inline)
Evidence: **[evidence]** the task lifecycle/state machine is enforced in the HTTP handler, not in a domain entity. The same rules are re-applied per entry channel (telegram, chat, cron) with drift risk; `tasks` is a dumb row + scattered guards.
Blast radius: a rule change (e.g. new cancellable state) is shotgun surgery across every dispatch path; inconsistent enforcement is a latent data-integrity bug.
Fix approach: lift the task state machine + invariants into `packages/agent` (or a `domain/` module) as the single owner; handlers call it. Pairs naturally with the repository fix above.
Door: two-way

### [P1] SSE subscriber registry is in-memory — caps the API at one replica
Expert(s): SCALE
Principle: 12-Factor VI (stateless processes / backing services)
Location: `apps/api/src/sse-emitter.ts:8,16,18` (`clients`/`userConnCounts`/`connOwners` module-level Maps); `emitToWorkspace` iterates only local `clients` (`:82-90`), no Redis pub/sub fan-out
Evidence: **[evidence]** the agent loop runs in-process and emits to the local Map only; a second API replica's SSE clients never receive events produced on replica 1.
Blast radius: real-time chat/agent UI silently breaks the moment you run >1 `api` replica. The app is structurally single-instance. This is the scaling cliff.
Fix approach: fan out SSE via Redis pub/sub (redis client already present — `apps/api/src/redis-client.ts`); each replica subscribes and pushes to its local clients. Until then, document the single-replica constraint explicitly.
Door: two-way

### [P1] Agent worker loop runs in-process in the API; singleton sweepers double-fire per replica
Expert(s): SCALE, OPS
Principle: 12-Factor VIII/XII (concurrency / admin processes)
Location: `apps/api/src/index.ts:675` (`startAgentLoop()`); `apps/api/src/agent-loop.ts:48-50` (module-level `activeTasks`/`running`/`sessionCount`), `:1988-1996` (4 `setInterval` sweepers)
Evidence: **[evidence]** task *claims* are safe under concurrency (`FOR UPDATE SKIP LOCKED`, `packages/queue/src/index.ts:98`), but the cron-style sweepers (`cleanupStaleTasks`, `recoverGhostTasks`) are unguarded singletons that double-fire on each replica, and worker capacity is welded to web request capacity.
Blast radius: cannot scale workers independently of web; duplicated sweeps race as soon as you add a replica (which the SSE finding already forbids — same root: single-process assumptions baked in).
Fix approach: split the worker into its own process (12-Factor admin/worker dyno), or guard sweepers with an advisory lock so only one replica runs them. Reversible.
Door: two-way

### [P1] pg pool `max=20` per process, no replica/worker budgeting
Expert(s): SCALE, DATA
Principle: capacity / Little's Law
Location: `packages/db/src/client.ts:68` (`max: 20`)
Evidence: **[evidence]** each API process also runs the agent loop + parallel-executor (`MAX_SPRINT_WORKERS=5`) + 4 timers off the *same* 20-conn pool; no documented check against Postgres `max_connections`. At 2 replicas you silently need 40 conns.
Blast radius: pool exhaustion → request stalls and worker starvation under load; failure mode is opaque (waiting clients, not errors).
Fix approach: size the pool from a capacity budget (replicas × pool ≤ max_connections − headroom); separate worker pool from request pool once the worker is split out; add a boot-time assertion.
Door: two-way

### [P1] Missing indexes on the three hottest append/poll tables
Expert(s): DATA, SCALE
Principle: index coverage vs real access pattern
Location: `packages/db/src/schema.ts` — `session_logs` (`:1347-1368`, **zero** secondary indexes; FKs `sessionId`/`userId` + `createdAt` all unindexed); `cron_jobs.nextRunAt` (`:650`, table has only a PK); `tasks` poller sort (`parallel-executor.ts:115-121`: filter covered by `tasks_status_retry_idx` but ORDER BY `priority,createdAt` is unindexed → in-memory sort of the whole queued set every tick)
Evidence: **[evidence]** `session_logs` is one row per request (worst-growing table) and is fully unindexed; the cron scheduler seq-scans `cron_jobs` every tick; the task poller re-sorts the queued set every poll (~96 tasks/hr created by gmail alone per memory).
Blast radius: all three degrade **linearly with growth** on the hottest paths (every request, every scheduler tick). Cheap to fix, expensive to leave.
Fix approach: add `(workspaceId/sessionId, createdAt)` indexes on `session_logs`; `(enabled, nextRunAt)` on `cron_jobs`; extend `tasks_status_retry_idx` (or add a partial index `WHERE status='queued'`) to cover `priority, createdAt`. Measure poller/scheduler latency before/after.
Door: two-way

### [P1] Committed half-migration `DRAFT_0124` — code ↔ prod schema drift risk
Expert(s): DATA, OPS
Principle: migration hygiene; 12-Factor (build/release/run parity)
Location: `packages/db/drizzle/DRAFT_0124_fanout_fields.sql` (marked "DO NOT APPLY", absent from `meta/_journal.json`); app code references fanout depth/total fields
Evidence: **[evidence]** the migration is parked in the tree but not journaled, while application code reads fanout columns that may not exist in prod → latent runtime error when that path executes.
Blast radius: a silent code/schema divergence that surfaces as a 500 only when the fanout path runs in prod — the classic "works in dev" trap.
Fix approach: decide and act — either finalize+journal+apply the migration (expand→migrate→contract) or remove the column references from code until it's ready. Don't leave a DRAFT in the applied-migrations directory.
Door: one-way (once applied to prod data)

---

## P2 — Coupling / integrity / observability

### [P2] Invite acceptance is a non-atomic two-write
Expert(s): DATA
Principle: transaction boundaries
Location: `apps/api/src/routes/members.ts:329-344` — `insert(workspaceMembers)` then a separate `update(workspaceInvites).set(usedAt)`; contrast `workspaces.ts:148` which *does* use `db.transaction` (only ~7 txn sites repo-wide)
Evidence: **[evidence]** a crash between the two writes leaves an invite consumed without membership, or membership without the invite marked used.
Blast radius: corrupt membership/seat state on partial failure; hard to detect.
Fix approach: wrap both writes in `db.transaction`. Audit the other multi-write sites (profile registration below, credit/debit paths) for the same.
Door: two-way

### [P2] Money stored as `real` (float4)
Expert(s): DATA
Principle: data integrity (no float currency)
Location: `schema.ts:326-328` (`tasks.costUsd`/`costCeilingUsd`), `:895-896` (`api_cost_tracking`), `:1213` (`models_knowledge.costPer*`)
Evidence: **[evidence]** cost ceilings are *compared* as floats; rounding error accumulates across transactions.
Blast radius: billing/ceiling drift that grows with transaction count; cost-enforcement decisions made on imprecise values.
Fix approach: migrate to `numeric`. Expand→backfill→contract; reversible with care.
Door: one-way (data migration)

### [P2] Core dimension columns stored as free-text despite 24 pgEnums existing
Expert(s): DATA, DOMAIN
Principle: constraints in the DB, not only app code
Location: `schema.ts:380-385` — `conversations.source`/`status`/`intent` are `text()` with allowed values only in a comment
Evidence: **[evidence]** app-only validation; a typo'd `source` persists silently and pollutes analytics grouping.
Blast radius: dirty dimension data, silently wrong analytics/synthesis aggregates.
Fix approach: promote to pgEnum or add CHECK constraints. Coordinate with the synthesis/analytics consumers.
Door: two-way

### [P2] `GET /nodes` returns unbounded rows
Expert(s): SCALE
Principle: pagination on growable data
Location: `apps/api/src/routes/nodes.ts:39-51` (`.select().from(nodes).orderBy(createdAt)`, no limit/offset); `nodeTrust` full scan `:56-58`. (tasks/conversations/node-events/memory ARE paginated — confirmed.)
Evidence: **[evidence]** federation node list grows unbounded with no cap.
Blast radius: payload + query cost grow with federation size; eventual timeout.
Fix approach: add cursor+limit like the sibling list endpoints already use.
Door: two-way

### [P2] In-memory auth/membership caches diverge across replicas
Expert(s): SCALE, SEC
Principle: 12-Factor VI; revocation latency
Location: `apps/api/src/middleware/better-auth.ts:109` (`userCache`, 60s TTL); `middleware/workspace-access.ts:46` (`membershipCache`, 30s pos / 5s neg)
Evidence: **[evidence]** revoked access lingers up to 30s on whichever replica holds a stale entry; inconsistent per replica. Bounded by TTL — hence P2.
Blast radius: brief authz-revocation lag; widens the multi-replica story already blocked by SSE.
Fix approach: acceptable single-replica; on scale-out move to a shared cache (Redis) or shorten/invalidate on membership change.
Door: two-way

### [P2] N+1 sequential inserts in profile registration
Expert(s): DATA
Principle: query-per-iteration; transaction
Location: `apps/api/src/routes/profiles.ts:123-139` — `for (const ext of exts) { await db.insert(extensionRegistry)… }`
Evidence: **[evidence]** one round-trip per extension, sequential, no batch, no txn; partial failure leaves a half-written registry.
Blast radius: latency = N×RTT on registration; inconsistent registry on failure.
Fix approach: single batch insert in a transaction.
Door: two-way

### [P2] God modules — ten files over 1000 LOC
Expert(s): ARCH
Principle: SRP / screaming architecture
Location: `packages/agent/src/executor/index.ts` **2741**; `apps/api/src/routes/chat.ts` **2038**; `apps/api/src/agent-loop.ts` **2034**; `routes/telegram.ts` **1701**; `agent/providers/registry.ts` **1386**; `channel-ai.ts` **1389**; `routes/extensions.ts` **1328**; `routes/connections.ts` **1315**; `agent/connections/bridge.ts` **1075**; `providers/call-model.ts` **1058**. Plus `schema.ts` 2090 LOC / 74 tables (one change-magnet file).
Evidence: **[evidence]** these are the shotgun-surgery hotspots; each is a merge-conflict and onboarding tax.
Blast radius: every change to chat/executor/agent-loop touches a 2000-line file; review and ramp cost compounds.
Fix approach: split by responsibility incrementally (do NOT rewrite). Schema.ts → split per bounded context (`schema/tasks.ts`, `schema/channels.ts`, …) re-exported from one barrel.
Door: two-way

### [P2] `apps/api/src` screams "framework", not the product
Expert(s): ARCH, DOMAIN
Principle: screaming architecture
Location: top level mixes HTTP plumbing (`routes/ middleware/ analytics/ federation/ sso/ stabilization/`) with ~40 loose domain files (`agent-loop.ts`, `outcome-capture.ts`, `parallel-executor.ts`, `channel-*.ts` = 3029 LOC, `cron*.ts`)
Evidence: **[evidence]** the product nouns (channels/tasks/memory/agents) are buried among delivery-mechanism folders and loose files.
Blast radius: a new engineer cannot locate "where channels live" from the tree — raises time-to-first-contribution.
Fix approach: group loose domain files under product modules (`channels/`, `tasks/`, `agents/`) over time. Low-risk, high-readability. Pairs with the god-module split.
Door: two-way

### [P2] Drizzle migration journal is stale — `db:migrate` would not apply 0130–0135
Expert(s): OPS, DATA
Principle: 12-Factor V (build/release/run); migration hygiene
Location: `packages/db/drizzle/meta/_journal.json` (last entry idx 128 / tag `0129_inference_logs_app_id`) vs migration files through `0135_profile_monitor_observations.sql`
Evidence: **[verified]** the journal stops at 0129 but six newer migration files (0130–0135) exist and are unjournaled, so `drizzle-kit migrate` (`db:migrate`) silently would not apply them. In practice migrations are applied **manually** by psql against prod (consistent with operator's deploy notes) — meaning the documented migration tool is non-functional and there is no automated drift check at release. The `DRAFT_0124` half-migration (P1 above) is the same root: the journal isn't the source of truth.
Blast radius: a new engineer running `db:migrate` from a clean clone gets a DB that's 6 migrations behind with no error; release/run parity depends entirely on a manual, undocumented psql step. Schema drift surfaces only as runtime 500s.
Fix approach: either (a) re-sync the journal and make `db:migrate` the single apply path, or (b) drop the journal pretence and document the manual-apply runbook as the canonical path with a CI `db:check-drift` gate (the `check-drift.ts` script already exists). Pick one and make it the contract.
Door: two-way

### [P2] No error aggregation (Sentry/equivalent)
Expert(s): OPS
Principle: observability
Location: zero `@sentry`/error-tracker refs repo-wide. Trace middleware (`middleware/trace.ts:16-22`, ulid requestId + AsyncLocalStorage correlation) and `/health` DO exist.
Evidence: **[evidence]** logging is structured and correlated, but unhandled errors aren't aggregated/alerted — they live only in logs.
Blast radius: regressions surface late (via logs/users), not proactively.
Fix approach: wire an error tracker to the existing trace requestId. Small, additive.
Door: two-way

---

## P3 — Polish / notes

- **[P3] `@plexo/logger` → `@plexo/db` is an acceptable sink, not a leak** (ARCH). `packages/logger/src/session-logger.ts:4` imports `{ db, sessionLogs }` only to `db.insert` (29 LOC, no domain types pulled). Only smell: logging is non-portable. **[verified]** Not worth refactoring.
- **[P3] tz-naive vs tz-aware timestamps mixed within one table** (DATA). `tasks`: `createdAt`/`claimedAt`/`retryAfter` are `mode:date` (no tz) while `claimedUntil`/`failedAt` use `withTimezone:true` (`schema.ts:355-360`); `retry_after<=NOW()` compares a naive column to tz `NOW()`. Migrations 0089/0126 retrofit tz elsewhere — incomplete.
- **[P3] Destructive `DROP TABLE` migrations with no down-path** (DATA). 0103 (`workspace_mindsets`, `scl_drift_warnings`), 0118 (synthesis tables). Drizzle has no down files — irreversible. Historical/applied; note for DR awareness.
- **[P3] Rate-limit gap on `/agents` and `/ai/complete`** (SEC). Rely on `generalLimiter` (2000/15min) + service-key rather than a dedicated expensive-endpoint limiter. Acceptable given service-key gating; tighten if those open to user sessions. **[verified]**
- **[P3] `__decrypt_failed__` sentinel** (SEC). `ai-provider-creds.ts:159` returns a sentinel string on decrypt failure; GET returns `CONFIGURED_SENTINEL` — confirmed no plaintext key leak. **[verified]** No action.

---

## Verified GUARDED — not findings (recorded so they aren't re-flagged)

- **Domain core is clean** (ARCH, **[verified]**): `packages/agent` + `packages/db` import zero framework/HTTP/Next/Hono types; `web→@plexo/db` is disciplined (only `lib/auth.ts` server-side + two files that explicitly avoid the runtime db import). No package import cycles. `db` is a true leaf. **No over-engineering / speculative ports found — the codebase errs toward too few boundaries, not too many.**
- **Webhooks all verify signatures before processing** (SEC, **[verified]**): GitHub HMAC-SHA256 timing-safe (`webhooks-github.ts:44-53`), Slack v0 HMAC (`slack.ts:51-54`), Twilio (`twilio.ts:162`), Telegram secret-token timing-safe (`telegram.ts:1498`), Discord Ed25519 (`discord.ts:87`).
- **No SQL injection** (SEC, **[verified]**): only `sql.raw` usage is `training-data.ts` on compile-time-constant strings, super-admin-gated. drizzle parameterization elsewhere.
- **Object-level authz is solid on sampled sensitive routes** (SEC, **[verified]**): tasks, api-keys, key-shares, shares, app-grants, workspaces, users (super-admin gated, no hashes returned), members (RBAC) all scope by workspaceId/ownership. The IDOR above is specific to the service-key dispatch path, not the user-session routes.
- **`pnpm audit --audit-level high`: no high/critical advisories.**
- **inngest IS used** for async work (extract-turn, lessons, gmessages); **no inline email/embeddings/LLM in request handlers** (all queued or in the worker loop); no `fs.writeFile` outside tmp.
- **Test shape is healthy, not inverted** (OPS, **[verified]**): 259 test files, 104 in `packages/agent` — domain logic is the most-tested layer; no zero-assertion tests found.

---

## Panel Verdict — **Sound with Fixes**

**ARCH:** The dependency *direction* is correct — domain core (`agent`, `db`) is framework-free and `db` is a true leaf, which is the hard part and it's done right. The debt is the *missing* persistence boundary: drizzle is welded across 82 route files and business invariants leak into handlers. This is fixable with a strangler-pattern repository layer and does not require a rewrite. No ceremonial over-architecture to unwind.

**DOMAIN:** Concepts are coherent (the Work/Task split is intentional, confirmed). The weakness is an anemic task aggregate — the state machine lives in HTTP handlers and re-appears per channel. Lift it into the domain and the model starts matching the business.

**SEC:** No public/unauthenticated hole, no SQLi, webhooks and user-session authz are properly guarded — genuinely good. The exposure is concentrated in one place: a single static shared service key that is both unscoped-per-app and unbound-per-user, enabling cross-tenant agent dispatch. Fix the key model and the largest security risk closes.

**DATA:** Multi-tenant indexing is generally disciplined; the gaps are the append/poll tables (`session_logs` fully unindexed, `cron_jobs`, the task poller sort) and integrity choices (float money, free-text enums, a non-atomic invite-accept). All are bounded, well-localized fixes. The `DRAFT_0124` half-migration is the one that can bite in prod soonest.

**SCALE:** The app is structurally single-replica — in-memory SSE registry, in-process worker loop with singleton sweepers, and a per-process pool with no replica budget. Nothing is broken at one instance, but horizontal scale-out is a cliff, not a slope. Redis pub/sub for SSE + a split worker process are the unlock.

**OPS:** Strong foundations — structured correlated logging, health checks, honored lockfile, single-command build, healthy test pyramid. Missing the last mile: error aggregation and an explicit "single-replica today" operational note.

### The three findings that most threaten scale, security, and speed
1. **Security:** the single static, unscoped, unbound `PLEXO_SERVICE_KEY` → cross-tenant agent dispatch (`agents-run.ts` + `auth.ts`). One leaked secret = total tenancy breach.
2. **Scale:** in-memory SSE registry + in-process singleton worker loop → the API cannot run more than one replica without silently breaking real-time UI and double-firing sweepers.
3. **Speed/integrity (tie):** fully-unindexed `session_logs` + cron/poller scans degrade the hottest paths linearly with growth; and the committed `DRAFT_0124` half-migration is a live code↔prod-schema drift waiting to 500.

---

**STOP — awaiting approval.** No fixes will be made until findings are approved. One-way-door items (DRAFT_0124 apply, money→numeric migration) require their own explicit approval each. On approval, Phase 3 consolidates live items into `PLAN.md` and Phase 4 executes in phased, strangler order with characterization tests first.
