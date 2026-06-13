# @joeybuilt/plexo-sdk — changelog

## 1.5.1 — 2026-06-13 — republish of 1.5.0

No source changes. The 1.5.0 publish never reached npm: the release workflow
failed with `ENEEDAUTH` (`pnpm publish` did not pick up the env-only auth token).
`release.yml` now writes the token to `~/.npmrc` explicitly, and this bump
re-triggers the pipeline so the `/connect` universal client below is actually
installable from npm.

## 1.5.0 — 2026-06-08 — **`/connect` universal client**

Adds the `@joeybuilt/plexo-sdk/connect` module: a single `PlexoClient`
(`createPlexoClient`) that lets any app register with Plexo Core and use it
without hand-rolling HTTP calls.

### Added

- **`createPlexoClient` / `PlexoClient`** — app registration (`register`),
  per-user workspace provisioning (`ensureWorkspace`), AI completion
  (`aiComplete`), chat (`chatMessage`), image analysis (`analyzeImage`),
  OCR, memory (store/search), event publish + dispatch, and an inbound
  handler (`inbound().handle`) for events and data queries.
- **Typed surface** — `PlexoClientOptions`, `AppExtension`,
  `AnalyzeImage*`, `Ocr*`, `Memory*`, `Inbound*`, `Dispatch*`, and related
  types exported from `@joeybuilt/plexo-sdk/connect`.
- **Errors** — `PlexoApiError`, `PlexoAuthError`,
  `PlexoNotConfiguredError`, `PlexoRateLimitedError`,
  `PlexoUnreachableError`.
- **Inbound signature verification** — `verifyInboundSignature`.

Additive minor per the 1.4.0 breakage policy — no host migration required.

## 1.4.0 — 2026-05-23 — **PEX 0.4.0 spec freeze**

This release marks the **freeze of the PEX 0.4.0 manifest surface**. Sprint A′
closure event per [ADR 0033](../../adr/0033-no-new-packages-until-a-prime-closes.md).

### Frozen surfaces

- **Manifest schema** — `ExtensionManifest` shape locked. Fields are
  additive-only until a `0.5.0` major; breaking changes require a new
  spec version + migration window.
- **Extension subtypes** — `'skill' | 'channel' | 'tool' | 'connector'`
  locked. `agent` manifest type also locked. No new top-level subtypes
  until 0.5.0.
- **Capability tokens** — current `CapabilityToken` union locked.
  Additions are permitted; renames or removals are breaking.
- **SDK runtime surface** — `PlexoSDK` interface (`storage`, `events`,
  `secrets`, `tools`, `escalation`) locked. Implementations may add
  fields; existing fields stay shape-stable.
- **SKILL.md frontmatter** — both the standard (`name`, `description`,
  `invocation`, `globs`, ...) and Plexo extensions (`runtime: plexo`,
  `capabilities`, `resource_limits`, ...) are frozen. New optional
  fields are permitted; renames/removals are breaking.

### Breakage policy

- **Additive changes** (new optional fields, new tokens, new optional
  SDK methods) — minor version bump (1.4.x → 1.5.0). No host migration
  required.
- **Renames or removals** — major version bump (1.x.x → 2.0.0) with a
  spec version bump (PEX 0.4.0 → PEX 0.5.0). Host must support both
  manifest versions for one minor cycle before removing the old shape.
- **Behavioral changes within a frozen API** — minor bump with a
  prominent CHANGELOG entry. Behavior changes that risk silent breakage
  for installed extensions require a deprecation cycle (≥1 minor of
  warn-only behavior before enforcement).

### What this enables

- Third-party extension authors can target PEX 0.4.0 with confidence.
- Plexo hosts can claim "PEX 0.4.0 Standard" host-compliance.
- SDK consumers (Levio, Fylo, Nexalog, Helm) get a stable target for
  their integration code.

### What's still in flight (post-freeze, does not block the spec)

- `extensions/core/fylo-bridge` — synthesis subscriber landed, full
  PEX tool surface (account list, transaction search) waits on Fylo
  implementing `/api/plexo/data`. Bridge-side scaffold tracks the
  levio-bridge shape; tracked separately, not a spec issue.
- ADR 0033 closure addendum — see [adr/0033-...](../../adr/0033-no-new-packages-until-a-prime-closes.md) for the lifted-gate note.

## 1.3.0 — 2026-05-12

### Added — `agents.runCustom` (EP1 + EP2 per Frame Forge ADR 0035)

- `client.agents.runCustom(workspaceId, { systemPrompt, tools, input, ... })`
  → `RunCustomResult`. Multi-step agent loop where the **caller** supplies
  the system prompt and tools[]; Plexo runs the Vercel AI SDK loop and
  dispatches each LLM tool call as a signed HTTP POST to the caller-provided
  `callbackUrl`. Synchronous (120s timeout); returns full `{ runId, output,
  steps[], truncated }` when the loop terminates.
- Tool dispatch contract: Plexo POSTs `{ runId, toolName, input }` to
  `tool.callbackUrl` with `Authorization: Bearer <runJwt>` (HS256,
  300s lifetime, claims: `{ workspaceId, runId, allowedTools[] }`).
  Caller's handler responds with `{ output: <string|json> }` or
  `{ error: <string> }`. 30s per-tool timeout.
- **EP2 — memory as tool.** Setting `enableMemoryTool: true` causes Plexo
  to register a `read_memory` tool in the LLM's tool list. The LLM can
  call it mid-loop to query stored memory via `{ query, limit?, type? }`.
- New types: `RunCustomOptions`, `RunCustomTool`, `RunCustomStep`,
  `RunCustomResult`.
- Server-side surface: `POST /api/v1/agents/run-custom` (Plexo API).
  Requires `PLEXO_RUN_JWT_SECRET` (≥32 chars) on the Plexo API container.

### Compatibility

- 1.2.0 surface unchanged. New method lands on `agents.runCustom`;
  nothing existing renames or moves.
- Internal: requires Plexo Core ≥ commit `34470cdf` (`POST /api/v1/agents/run-custom`
  + per-run JWT middleware). Older Plexo cores will return 404.

## 1.2.0 — 2026-05-09

### Added — Synchronous gmessages tool-invoke (Levio↔gmessages bridge)

- `client.tools.gmessages.send({ workspaceId, threadId?, phoneE164?, text })`
  → `{ messageId, deliveryStatus }`. Synchronous HTTP path into the libgm
  sidecar; blocks until the sidecar accepts or rejects the request. Errors
  bubble (NOT swallowed) so the calling app's chat UI can surface them.
- `client.tools.gmessages.listThreads({ workspaceId, phoneE164?, limit? })`
  → `GmessagesThread[]`. Folds `conversations` rows into per-thread summaries
  ordered most-recent first.
- New types: `GmessagesSendOptions`, `GmessagesSendResult`,
  `GmessagesListThreadsOptions`, `GmessagesThread`,
  `GmessagesThreadParticipant`, `GmessagesLastMessage`.

### Known gaps in 1.2.0 (server-side, not SDK)

- `participants: []` is always empty — gmessages schema has no per-thread
  participant table and libgm does not surface a participant list via the
  sidecar. The field ships for forward-compatibility.
- `unreadCount: 0` is always zero — `conversations` does not track read
  state for gmessages.
- `send({ phoneE164, ... })` without `threadId` returns HTTP 501
  `PHONE_LOOKUP_NOT_IMPLEMENTED` — supply `threadId` from `listThreads()`.
  Phone→thread resolution requires a sidecar endpoint that does not exist
  yet. The SDK accepts the param so future enrichment is non-breaking.

### Compatibility

- 1.1.0 surface unchanged. New methods land on the SDK's new
  `tools.gmessages` namespace; nothing existing renames or moves.
- Internal: requires Plexo Core ≥ the commit that adds
  `POST /api/v1/connections/gmessages/send` +
  `GET /api/v1/connections/gmessages/threads` (this PR). Older Plexo cores
  will return 404 on the new routes; unlike addEpisode/searchFacts the new
  methods do NOT swallow errors (a chat send failure must surface to the
  user), so callers must wrap with try/catch.

## 1.1.0 — 2026-05-11

### Fixed — Webpack/edge bundling at Next.js consumers

- tsup `onSuccess` hook now restores the `node:` prefix on Node built-in
  imports in dist. esbuild strips `node:` from external imports during ESM
  emit (even with `platform:'node'`), which broke Next.js webpack + edge
  runtime bundling at consumer sites — webpack couldn't resolve bare `crypto`.
- Source-level imports already used `node:crypto`; the fix preserves that
  contract end-to-end through the build pipeline.
- No public-API change. Pure build artifact correctness.

### Added — Graph methods (Phase 8 of `graphiti-migration/plan.md`)

- `PlexoClient.addEpisode(workspaceId, opts)` — append a knowledge-graph episode
  for the workspace; the Graphiti sidecar runs entity + relationship extraction
  and returns the episode UUID + extracted-fact count.
- `PlexoClient.searchFacts(workspaceId, query, limit?)` — hybrid search across
  the workspace's facts; returns the matching `EntityEdge` set with bi-temporal
  metadata (valid_at / invalid_at).
- New types: `AddEpisodeOptions`, `AddEpisodeResult`, `FactSearchResult`.

### Deferred to 1.2.0

- `PlexoClient.searchNodes(...)` — graphiti-core 0.29 has no `search_nodes`
  method; richer `search_()` (returning SearchResults w/ nodes) needs a sidecar
  surface change to expose. Lands when the surface is stable.
- `PlexoClient.getCommunity(...)` — graphiti-core 0.29 only has
  `build_communities` (a builder, not a getter). A community accessor needs
  custom Cypher/Kuzu queries on the sidecar.

### Compatibility

- 1.0.0 surface unchanged. Existing `storeMemory` / `searchMemory` continue to
  hit the workspace's `memory_entries` table via the SDK's existing routes; the
  new graph methods are additive and call new `/api/v1/graph/*` routes against
  the same Plexo Core instance.
- Internal: requires Plexo Core ≥ the commit that adds `apps/api/src/routes/graph.ts`
  + `services/graphiti-sidecar/main.py` Phase 3c wiring + `MEMORY_WRITE_BACKEND`
  flag plumbing. Older Plexo cores will return 404 on `/api/v1/graph/episodes`;
  the SDK methods return null/[] in that case (best-effort semantics preserved).
