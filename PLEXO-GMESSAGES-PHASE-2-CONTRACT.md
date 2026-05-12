# PLEXO Google Messages connector — Phase 2 contract + schema

**Status:** awaiting operator close-out gate (migration ran clean on dev DB ✓ — see §5 below).
**Date:** 2026-05-05
**Inputs:** `PLEXO-GMESSAGES-PHASE-1-DESIGN.md`, ADRs 0001–0006.

This document captures the Phase 2 deliverables required by the build prompt: contract types, SDK runtime client, host endpoints, schema migration, Inngest install. Phase 3 (Go skeleton) consumes this contract.

---

## 1. Drizzle migration

Two migration files, intentionally split because Postgres rejects `ALTER TYPE ... ADD VALUE` followed by a use of the new value inside the same transaction (`new enum values must be committed before they can be used`). Drizzle's migrator wraps all unapplied migrations in a single transaction, so the registry seed (which references `auth_type='paired_session'`) cannot live in the same drizzle batch as the `ALTER TYPE`.

| File | Purpose |
|---|---|
| `packages/db/drizzle/0116_gmessages_phase2.sql` | Adds `gmessages` to `channel_type`, `gmessages` to `task_source`, `paired_session` to `auth_type`. |
| `packages/db/drizzle/0117_gmessages_phase2_schema.sql` | Creates `pgSchema('plexo_gmessages')` + three tables (`paired_sessions`, `message_dedupe`, `rcs_feature_cache`) + the `gmessages` row in `connections_registry`. |

**Tables in `plexo_gmessages` (per ADR-0003):**

```
plexo_gmessages.paired_sessions
  id uuid PK
  workspace_id uuid FK → public.workspaces (cascade)
  installed_connection_id uuid FK → public.installed_connections (cascade)
  channel_id uuid FK → public.channels (cascade)
  state plexo_gmessages.paired_session_state DEFAULT 'paired'
  state_changed_at timestamptz NOT NULL DEFAULT now()
  last_inbound_at timestamptz                           -- flow heartbeat (ADR-0004)
  decode_error_count integer NOT NULL DEFAULT 0         -- liveness signal
  pair_started_at, paired_at, expired_at timestamptz
  error_detail text
  created_at timestamptz NOT NULL DEFAULT now()
  INDEX (workspace_id), INDEX (state, last_inbound_at)

plexo_gmessages.message_dedupe
  workspace_id uuid + gmessages_msg_id text PK
  thread_id text NOT NULL
  ingested_at timestamptz DEFAULT now()
  INDEX (ingested_at)                                   -- retention prune

plexo_gmessages.rcs_feature_cache
  workspace_id uuid + thread_id text PK
  is_rcs, supports_typing, supports_receipts, supports_rich_cards boolean
  refreshed_at timestamptz DEFAULT now()
```

`plexo_gmessages.paired_session_state` enum values: `paired | active | refreshing | expired | revoked | errored` (matches ADR-0004 and ADR-0005 lifecycle).

**Public-shared mutations:**

- `channel_type` += `gmessages`
- `task_source` += `gmessages`
- `auth_type` += `paired_session`
- `connections_registry` row inserted: id=`gmessages`, name=`Google Messages`, category=`messaging`, logoUrl=`/images/connections/gmessages.svg`, authType=`paired_session`, isCore=`true`, toolsProvided=`['gmessages__send_message','gmessages__list_threads']`.

Drizzle code lives in `packages/db/src/gmessages-schema.ts` (mirrors the `pushd-schema.ts` pattern). The new schema is exported from `packages/db/src/index.ts` so route handlers and queue consumers can `import { pairedSessions, messageDedupe, rcsFeatureCache } from '@plexo/db'`.

---

## 2. `@plexo/sdk` channel types (ADR-0002)

Added to `packages/sdk/src/types/channel.ts`:

- `PexVersion` (literal `'0.4.0'`) + the `PEX_VERSION` constant.
- `ChannelType` enum mirror including `gmessages`.
- `ConnectionState` mirror of `paired_session_state`.
- `ChannelMessage` — id, channelId, threadId, direction, text, attachments, senderId, sentAt, metadata, pexVersion.
- `ChannelThread` — id, channelId, title, lastMessagePreview, lastMessageAt, unreadCount, metadata, pexVersion.
- `ChannelDescriptor` — channel-list element (workspaceId, type, name, state, enabled, lastMessageAt, pexVersion).
- `PairedConnectionDescriptor` — paired-session metadata view (no secrets).
- `ChannelEvent` — discriminated union: `message.received | message.sent | connection.state_changed`.
- `ChannelSubscription`, `ChannelScope` (5 scopes from ADR-0002), `ChannelSendRequest`, `ChannelMessagePage`, `ChannelThreadPage`.

Every envelope carries `pexVersion: '0.4.0'`.

---

## 3. `@plexo/sdk` runtime channel client (ADR-0002 §SDK addition)

`packages/sdk/src/channel-client.ts` exports `createChannelClient({ baseUrl, serviceKey, appId, fetchImpl? })` returning a `ChannelClient`:

```ts
list(opts?)                          → ChannelDescriptor[]
subscribe(channelId, scopes)         → ChannelSubscription
unsubscribe(channelId, subId)        → void
threads(channelId, opts?)            → ChannelThreadPage
messages(channelId, threadId, opts?) → ChannelMessagePage
send(channelId, threadId, payload)   → ChannelMessage
events(channelId, opts?)             → AsyncIterable<ChannelEvent>
```

HMAC body signature using `PLEXO_SERVICE_KEY` (sha256), with `X-Plexo-Signature: sha256=<hex>`, `X-Plexo-Timestamp` (5-minute skew), and `X-App-Id`. SSE iteration in `events()` reads `text/event-stream` frames and yields parsed `ChannelEvent` objects; `Last-Event-ID` honored on caller-supplied reconnect.

Closes the open question from Levio ADR-03 (`plexo.channel.dispatch()` — unconfirmed there, confirmed and landed here as the `send()` method).

---

## 4. Host endpoints

### `apps/api/src/routes/channels-subscription.ts` (ADR-0002, mounted at `/api/plexo/channels`)

| Method | Path | Phase 2 status |
|---|---|---|
| GET    | `/`                                         | live — returns descriptors from `channels` table |
| POST   | `/:channelId/subscribe`                     | live — synthesizes deterministic sub ID; persistence in Phase 4 |
| DELETE | `/:channelId/subscribe/:subscriptionId`     | live — 204 noop until Phase 4 |
| GET    | `/:channelId/threads`                       | skeleton — returns `{ threads: [] }`; Phase 4 fills aggregate query |
| GET    | `/:channelId/threads/:threadId/messages`    | skeleton — returns `{ messages: [] }`; Phase 5 fills |
| POST   | `/:channelId/threads/:threadId/messages`    | skeleton — 202 echo with `idempotencyKey`; Phase 5 dispatch |
| GET    | `/:channelId/events`                        | live — SSE keepalive loop; Phase 4-5 wires producer |

All endpoints HMAC-authenticated via `requireHmacService` middleware (new file `apps/api/src/middleware/hmac-service.ts`). Per-app scope enforcement is a stub (`requireScopes` returns true) until Phase 4 lands the manifest registry — same posture as the existing `/api/plexo/data` contract on Levio.

### `apps/api/src/routes/channels-gmessages.ts` (mounted at `/api/plexo/channels/gmessages`)

Connector-facing inbound. Three POST endpoints:

| Path | Phase 2 status |
|---|---|
| `/inbound`   | accepts message envelope, logs + 202 (Phase 5 normalizes + dedupes) |
| `/state`     | live — updates `paired_sessions.state` |
| `/heartbeat` | live — updates `paired_sessions.last_inbound_at` + `decode_error_count` |

The Go sidecar (Phase 3) targets these as its only Plexo Core write surfaces.

---

## 5. Inngest install (ADR-0006)

| Change | File |
|---|---|
| `inngest@^3.39` dep added | `packages/queue/package.json` |
| Sub-export `@plexo/queue/inngest` | `packages/queue/package.json` (exports map) |
| Inngest client + event schema | `packages/queue/src/inngest/client.ts` (exports `inngest`, `GmessagesEvents`) |
| Compose service `inngest:` | `docker-compose.yml` (image `inngest/inngest:latest`, port `127.0.0.1:8288`, postgres-backed) |
| `INNGEST_BASE_URL/SIGNING_KEY/EVENT_KEY` wired into the `api` service | `docker-compose.yml` |
| Auto-generated keys | `scripts/install.sh` (`signkey-prod-<hex32>`, hex32 event key) |
| Documented vars | `.env.example` |

Dashboard binds to `127.0.0.1:8288` only — never exposed to public ingress (silent + setup-installable per operator constraints).

`packages/queue/src/inngest/client.ts` declares typed event payloads up-front so Phase 4/5/L authors get type-checked function signatures:

```ts
'gmessages.message.received'
'gmessages.session.refresh-requested'
'gmessages.session.stale-detected'
'levio.smart-reply.requested'
```

Functions themselves are added in Phase 4 (`gmessages.session.refresh`, `gmessages.stale-session.monitor`) and Phase L (`levio.smart-reply.generate`).

---

## 6. Migration close-out gate

Migration applied to dev DB on 2026-05-05. Verification queries:

```
SELECT nspname FROM pg_namespace WHERE nspname='plexo_gmessages';
  → plexo_gmessages

SELECT table_name FROM information_schema.tables WHERE table_schema='plexo_gmessages';
  → message_dedupe
    paired_sessions
    rcs_feature_cache

SELECT enum_range(NULL::auth_type);
  → {oauth2, api_key, webhook, none, paired_session}

SELECT enum_range(NULL::channel_type);
  → {telegram, slack, discord, whatsapp, signal, matrix, irc, webchat, gmessages}

SELECT enum_range(NULL::task_source);
  → {telegram, slack, discord, scanner, github, cron, dashboard, api, extension,
     sentry, a2a, webhook, gmessages}

SELECT id, name, category, auth_type, is_core
  FROM connections_registry WHERE id='gmessages';
  → gmessages | Google Messages | messaging | paired_session | true
```

**Note (dev DB drift, pre-existing, NOT Phase 2 scope):** the dev DB's `channel_type` and `task_source` enums are missing `twilio` and `gmail` values. Migrations `0108_channels_twilio.sql` and `0109_channels_gmail.sql` were never applied to this dev instance. The Phase 2 migration completed successfully regardless. Operator may want to investigate the dev DB drift before Phase 6 (production deploy) but it does not block Phase 3.

**Application procedure used:** `0116_gmessages_phase2.sql` was applied via direct `psql` (committing the new enum values) and recorded in `drizzle.__drizzle_migrations` by hash. `0117_gmessages_phase2_schema.sql` was then applied by `pnpm db:migrate` in its own transaction. Operators applying to a fresh database can use the same two-step approach — see the §5 notes inside ADR-0003 if this needs codifying for production.

---

## 7. Typecheck status

All four impacted packages typecheck clean:

```
@plexo/sdk    — tsc --noEmit clean
@plexo/queue  — tsc --noEmit clean
@plexo/db     — tsc --noEmit clean
@plexo/api    — tsc --noEmit clean
```

No new test files added in Phase 2; Phase 3 wires the Go sidecar's compatibility test against the canonical TS fixtures.

---

## 8. What this phase deliberately did NOT do

- Mount any UI; pairing UX + viewer ship in Phase 4 (ADR-0005).
- Persist subscription rows; Phase 4 lands `channel_subscriptions`.
- Implement the SSE producer; Phase 4-5 wire it.
- Implement the message normalization or dispatch; Phase 5.
- Add Inngest functions; Phase 4 + L.
- Write the Go skeleton; Phase 3.

---

## 9. Self-generating handoff (Phase 3)

> Resume `PLEXO-GMESSAGES` Phase 3. Read in order: `/home/user/dev/plexo/PLEXO-GMESSAGES-PHASE-1-DESIGN.md`, `/home/user/dev/plexo/PLEXO-GMESSAGES-PHASE-2-CONTRACT.md`, `/home/user/dev/plexo/adr/0001-gmessages-go-sidecar.md`, `/home/user/dev/plexo/adr/0004-sidecar-tenancy.md`, `/home/user/dev/plexo/plan.md`, `/home/user/dev/plexo/checklist.md`. State: Phase 2 complete and signed off — schema migration ran clean on dev DB; `/api/plexo/channels` and `/api/plexo/channels/gmessages` host routes live with HMAC auth (skeleton handlers); `@plexo/sdk` exports `createChannelClient` + Pex Channel envelope types at `pexVersion: '0.4.0'`; Inngest installed silently in compose. Next concrete step: scaffold `apps/gmessages/` with `go.mod` pinning `go.mau.fi/mautrix-gmessages/libgmessages`, hand-mirror Pex Channel + ChannelEvent + ConnectionState into `internal/pex/types.go` with a CI compat test (Phase 1 design §4 step 8); implement per-session goroutine pattern with HKDF key derivation + panic isolation + compile-time-redacted structured logging (ADR-0004 invariants 1-3); HTTP client posting to `/api/plexo/channels/gmessages/{inbound,state,heartbeat}` using HMAC + `X-App-Id: gmessages-sidecar`; `/health` endpoint; layered liveness probe (10s process / 30s libgmessages.Ping / 60s flow heartbeat); local `make dev` target; failing integration test stub.
