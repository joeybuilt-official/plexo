# Channel-agnostic interaction layer — audit & design

**Status:** Design proposal (no refactor performed). Branch `plexo-ui`.
**Requirement:** every human-in-the-loop action (notify, deliver result, request/record verdict, request/apply revision approval, steer/inject) must work across all channels — Telegram, web, Slack, email (Gmail), SMS (Twilio), Discord — through adapters, not per-channel one-offs.

**TL;DR of the audit:** Outbound delivery is genuinely multi-channel today, but via an inline `if/else` chain, not an adapter interface, and the web app is not a delivery target. Inbound is asymmetric: `steer/inject` and `record_verdict` already have a channel-agnostic HTTP entry (`POST /tasks/:id/inject`), but **revision approval is Telegram-only** (text-parsed inside `telegram.ts`, with the action function imported directly). Verdict handling is partially duplicated between `telegram.ts` and `slack.ts`. Addressing is already generic (`channel:address`).

---

## 1. Coupling map (per touchpoint, file-cited)

### 1a. Outbound — notify / deliver result
**Multi-channel, but branch-coupled. Not Telegram-only.**
- `deliverToOriginChannel(payload)` — `apps/api/src/channel-delivery.ts:232`. Inline `if/else` over `context.channel`: `telegram` (:247), `slack` (:249), `discord` (:252), `twilio`/SMS (:254), `gmail`/email (:256). The comment at :243 explicitly notes a deliberate decision to stay with `if/else` until 6–7 channels (currently 5).
- Progress updates: `startTaskProgressUpdates` (:114) — same `if/else` (telegram/slack/discord/twilio/gmail).
- Transition delivery: `deliverTaskTransition` (:557) — same branch shape.
- Per-channel send primitives are real and implemented: `slackSend` (:150), `deliverToGmail` (:329), Discord/Twilio sends. Adapters are **not** stubbed — they work.
- A *second*, already-generic outbound path exists: `dispatchChannel()` behind `POST /api/v1/channel/dispatch` (`apps/api/src/routes/channel-dispatch.ts:5`), taking `{ channel, recipientUserId, message }`. Channel-agnostic input, used by external apps.
- **Web is absent** from every outbound branch. Web "delivery" is pull-based (the new SSE/poll views), not a push target. `deliverToOriginChannel` is explicitly skipped when a task has no `channelRef` (channel-delivery.ts:550 comment).
- **Addressing is already generic:** `notify_channel` is a `text` column (`packages/db/src/schema.ts:656`) in `channel:address` form, parsed as `notifyChannel.split(':', 2) → [channel, chatId]` (`apps/api/src/cron-dispatch.ts:176`).

**Verdict:** outbound is multi-channel with generic addressing, but dispatch is an inline branch, not a registered adapter; web is not modeled as a channel.

### 1b. Inbound — steer / inject
**Already channel-agnostic.**
- `POST /api/v1/tasks/:id/inject` — `apps/api/src/routes/task-inject.ts:24`. Injects a user message as a `task_steps` row; any channel can call it. This is the generic inbound seam.

### 1c. Inbound — request / record verdict
**Core generic; triggers partly duplicated.**
- `recordHumanVerdict(taskId, verdict)` — `apps/api/src/outcome-capture.ts:73`. Channel-agnostic by signature (ids only). Its own docstring frames it as the "Telegram reply → inject → recordHumanVerdict" path (:19, :70), but the call site is generic: `task-inject.ts:82-86` detects ✓/✗ / accept/reject and calls it. So **verdict-via-inject is already channel-agnostic.**
- However Telegram (`telegram.ts:822`) and Slack (`slack.ts:420`) each contain their own `result.outcome === 'approved'` handling — **duplicated per-channel logic**, not a shared path.

### 1d. Inbound — request / apply revision approval
**Telegram-only. The real gap.**
- `applyRevision` / `rejectRevision` cores — `apps/api/src/cron/distill-retro.ts` — are channel-agnostic (take `revisionId`, `reviewedBy`).
- But the only inbound trigger is a **Telegram text parse**: regex `^(approve|reject) <uuid>$` in `apps/api/src/routes/telegram.ts:779-801`, which dynamically imports `applyRevision`/`rejectRevision` and calls them, replying with Telegram-shaped messages. There is **no generic HTTP endpoint** for revision approval. Slack/SMS/email cannot approve a revision. The web revision-review UI has nothing to call.

### 1e. Inbound transport (per channel)
- Telegram webhook: `telegram.ts:1486` (`POST /webhook/:channelId`), inline-button `callback_query` handling at :453/:467 — Telegram-shaped.
- Slack inbound: `apps/api/src/routes/slack.ts`; Twilio/SMS inbound: `apps/api/src/routes/twilio.ts` (ingests messages; does **not** reach revision approval).
- Partial adapter notion already exists: `registerChannelToken(workspaceId, token)` (channel-delivery.ts:49) is called on init by `telegram.ts` — a token registry, but only Telegram populates it.

### Coupling summary table

| Touchpoint | Core action | Inbound trigger reach | Coupling |
|---|---|---|---|
| notify / deliver | `deliverToOriginChannel` (multi-ch) | n/a (outbound) | Branch `if/else`, web absent |
| steer / inject | `POST /tasks/:id/inject` | any channel (HTTP) | **Generic already** |
| record verdict | `recordHumanVerdict` | inject (generic) + TG + Slack dupes | Core generic, triggers duplicated |
| apply revision approval | `applyRevision`/`rejectRevision` | **Telegram text only** | **Telegram-coupled — gap** |

---

## 2. Design — canonical actions + adapter interface (proposal)

### 2a. Canonical actions (channel-neutral)
A small, closed set the core emits/consumes. Channels never see each other's shapes.

```ts
type CanonicalAction =
  | { kind: 'notify';          taskId; workspaceId; text; level }
  | { kind: 'deliver';         taskId; workspaceId; deliverable; assets? }
  | { kind: 'request_verdict'; taskId; workspaceId; prompt }
  | { kind: 'request_approval'; revisionId; workspaceId; diff; prompt }   // generalises revision-approval
  | { kind: 'steer';           taskId; workspaceId; message }

// Inbound, the inverse — a channel parses a raw event into one of:
type InboundIntent =
  | { kind: 'inject';   taskId; text }
  | { kind: 'verdict';  taskId; verdict: 'accept' | 'reject' }
  | { kind: 'approval'; revisionId; decision: 'approve' | 'reject' }
```

### 2b. Adapter interface
One interface per channel. Outbound renders + sends; inbound parses a raw transport event into a canonical intent and hands it to the **shared** action handlers (which already exist: `recordHumanVerdict`, `applyRevision`/`rejectRevision`, inject insert).

```ts
interface ChannelAdapter {
  readonly channel: string                              // 'telegram' | 'web' | 'slack' | 'gmail' | 'twilio' | 'discord'
  // OUTBOUND: canonical action -> channel-specific render + transport
  send(addr: ChannelAddress, action: CanonicalAction): Promise<void>
  // INBOUND: raw transport event -> canonical intent (or null if not an action)
  parse(raw: unknown): InboundIntent | null
  // optional lifecycle (token registry etc.)
  init?(workspaceId: string, cfg: unknown): void
}

// channel:address stays the wire format (already used). Adapter owns decoding.
type ChannelAddress = { channel: string; address: string; thread?: string }
```

A `ChannelRegistry` maps `channel -> ChannelAdapter`. Dispatch becomes:
`registry.get(addr.channel).send(addr, action)` — replacing the `if/else` in `deliverToOriginChannel`. Inbound webhooks become thin: each route calls `adapter.parse(raw)` then routes the `InboundIntent` to the shared handler — **no per-channel copy of approval/verdict logic.**

### 2c. Web as a first-class adapter (not a special case)
- Outbound `send()`: writes a canonical action to a workspace event store / SSE topic the web app already consumes (the Phase-2 `/agents/active/stream` + `/tasks/:id/steps/stream` infra). "Notify/deliver" to web = emit an event, not push to a third party.
- Inbound `parse()`: the web revision-review UI POSTs `{ revisionId, decision }` to a generic endpoint (e.g. `POST /api/v1/revisions/:id/decision`); the web adapter `parse()` returns `{ kind:'approval', ... }`. Identical downstream path to Telegram.

### 2d. Both Telegram and web routing through the layer
```
Telegram webhook ─▶ telegramAdapter.parse(update) ─▶ InboundIntent ─┐
Web UI POST      ─▶ webAdapter.parse(body)         ─▶ InboundIntent ─┼─▶ shared handler
                                                                      │   (applyRevision / recordHumanVerdict / inject)
Slack / SMS / email  (future) ── new adapter.parse() ─────────────────┘
core emits CanonicalAction ─▶ registry.get(channel).send(addr, action) ─▶ {telegram|web|slack|…}
```
Adding Slack/email/SMS approval = implement one `ChannelAdapter` (parse + send). No core change.

---

## 3. Open decisions (escalate — not decided here)

1. **Abstraction boundary.** Confirm the canonical action/intent set above is the right closed set. Notably: should `request_approval` be a generalisation of revision-approval (recommended — it's the only Telegram-coupled action), or stay revision-specific for now?
2. **Refactor-behind vs wrap (Telegram).** Two options for the existing, working Telegram paths:
   - **Wrap (low-risk, recommended first):** introduce `ChannelAdapter` + registry, implement `telegramAdapter` and `webAdapter`, and make the *new* generic approval endpoint route through the registry. Leave `deliverToOriginChannel`'s `if/else` in place initially (it already works) and migrate channels into adapters incrementally. The revision-review UI ships against the new generic endpoint immediately.
   - **Refactor-behind (cleaner, riskier):** replace the `deliverToOriginChannel` / `deliverTaskTransition` / `startTaskProgressUpdates` `if/else` chains with `registry.get(...).send(...)` in one pass. Higher blast radius across `channel-delivery.ts` (770 lines) + every webhook route.
3. **De-dup verdict logic.** `telegram.ts:822` and `slack.ts:420` both implement approval/verdict handling. Fold both into the shared handler via `parse()` now, or defer?
4. **New generic endpoints.** Approve `POST /api/v1/revisions/:id/decision` (the missing seam) as the first endpoint built on this layer. Verdict already has `/tasks/:id/inject`; keep or add an explicit `/tasks/:id/verdict`?
5. **Web "delivery" semantics.** Confirm web notify/deliver = emit-to-SSE-topic (pull) rather than a stored outbox, reusing the Phase-2 stream infra.

---

## 4. Consequence for the next slice
The **revision-review UI ships as the first consumer of this layer**, not a web one-off: it must POST to the new generic approval endpoint (decision 4) whose handler calls the existing `applyRevision`/`rejectRevision`. That single endpoint is simultaneously what a future Slack/email approve button would call — proving the adapter boundary on day one.
