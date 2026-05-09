# Plan — SCL endpoints rollout

**Goal:** ship the four `/api/v1/scl/*` endpoints nexalog already calls, type them in `@joeybuilt/plexo-sdk@1.1.0`, and replace nexalog's raw-fetch wrappers — moving nexalog's concept-graph features from silent-fail to working in prod.

**Related docs:**
- `/home/dustin/dev/joeybuilt/plexo/adr/0008-scl-endpoints.md` — decision + pre-mortem + conflicts
- `/home/dustin/dev/joeybuilt/plexo/adr/0006-sdk-rollout-strategy.md` — parent rollout this completes
- `/home/dustin/dev/joeybuilt/plexo/packages/sdk/plan.md` — SDK rollout (done; this is its last open item)

## Endpoints (final)

| Verb | Path | Body / params | Returns |
|------|------|---------------|---------|
| POST | `/api/v1/scl/mutate` | `{ workspaceId, concepts: [{label, type}], source }` | `{ ok: true }` |
| POST | `/api/v1/scl/expand` | `{ workspaceId, stimulus, depth?, width? }` | `{ nodes: [{id, label, type}], truncated: bool }` |
| GET  | `/api/v1/scl/record/meta?workspaceId=…` | query | `{ meta: GoldenRecordMeta \| null }` |
| POST | `/api/v1/scl/extract/trigger` | `{ workspaceId, sourceLogId? }` | `{ ok: true }` (fire-and-forget) |

## Phases

### Phase 1 — Plexo Core: query module + router + tests ✅ done (2026-05-09, uncommitted → committed in this session)
**Status:** all code shipped. typecheck + 13/13 tests pass. Push deferred for operator authorization (auto-deploy).
**Deviations from plan:**
- `expandConceptGraph` is MVP substring-match, not full BFS. Edge-aware traversal deferred until edges are persisted (graph_json schema currently only stores concepts[]). Depth param is parsed but unused; width still binds result count.
- `triggerSclExtract` is log + 200, not an enqueue. Real SCL extraction already runs via cron (`evaluateSclPromotion`), so the trigger endpoint mostly serves as a heartbeat/audit signal. Future: wire real enqueue.
- 3 pre-existing typecheck errors in `apps/api/src/lib/deepgram.ts` and `apps/api/src/routes/telegram.ts` (Buffer→BlobPart) — not introduced by SCL work.

**Scope:**
- Add `packages/agent/src/memory/scl-query.ts` exporting `mutateConceptGraph`, `expandConceptGraph`, `getGoldenRecordMeta`, `triggerSclExtract`.
- Mutate uses `SELECT … FOR UPDATE` row lock; append-only merge into `graph_json`.
- Expand uses BFS over `graph_json`, depth ≤ 4 (default 2), width ≤ 200 (default 50), `truncated` flag when caps hit.
- Add `apps/api/src/routes/scl.ts`, mount `v1.use('/scl', sclRouter)` in `apps/api/src/index.ts` adjacent to synthesis/themes.
- Service-key auth inside router, matching `synthesis`/`themes` precedent.
- Add `apps/api/src/__tests__/scl-routes.test.ts` (happy path + auth-fail per route).

**Dependencies:** none (DB schema already exists at `packages/db/src/schema.ts:1680`).
**Context budget:** ≤30%.
**Subagents:** Explore for `synthesisRouter`/`themesRouter` shape if patterns aren't obvious. general-purpose for the test file write if its shape balloons.
**Exit criteria:**
- `pnpm -C apps/api typecheck` clean.
- `pnpm -C apps/api test` passes (new tests + no regression).
- Routes return 401 without service key, 200 with valid payload (manual curl ok).

⚠ Operator gate: Security/Operability auth-shape conflict (ADR 0008). Confirm service-key choice before merge.

### Phase 2 — SDK: types + methods + 1.1.0 publish
**Scope:**
- Add 4 methods to `PlexoClient` in `packages/sdk/src/connect/client.ts` after the visionOcr block (~line 315):
  - `sclMutate(workspaceId, concepts, source): Promise<void>`
  - `sclExpand(workspaceId, stimulus, opts?): Promise<{nodes, truncated}>`
  - `sclRecordMeta(workspaceId): Promise<GoldenRecordMeta | null>`
  - `sclExtractTrigger(workspaceId, sourceLogId?): Promise<void>`
- Type definitions co-located w/ existing types in `packages/sdk/src/types/`.
- Bump `packages/sdk/package.json` → `1.1.0`. Update `CHANGELOG.md` if present.
- `pnpm -C packages/sdk build && pnpm -C packages/sdk typecheck`.

**Dependencies:** Phase 1 merged + Plexo Core deployed.
**Context budget:** ≤15%.
**Subagents:** none.
**Exit criteria:**
- SDK build clean.
- SDK typecheck clean.
- Existing consumer typecheck (run `pnpm -C apps/web typecheck` if web consumes SDK; otherwise app-starter / levio dry-run via `pnpm pack` + local install).

⚠ One-way door: `npm publish`. Operator sign-off gate before publish.

### Phase 3 — Nexalog: swap raw fetch → SDK
**Scope:**
- Update `lib/plexo.ts` lines 99–180:
  - Replace `plexoSclMutate` → call `client.sclMutate(...)`.
  - Replace `plexoSclExpand` → call `client.sclExpand(...)`.
  - Replace `plexoGoldenRecordMeta` → call `client.sclRecordMeta(...)`.
- Update `lib/enrichment/embeddings.ts:375` — replace inline fetch with `client.sclExtractTrigger(...)`.
- Bump pin: `nexalog/package.json` → `"@joeybuilt/plexo-sdk": "^1.1.0"`. `pnpm install`.
- 5 call-sites verified unchanged externally:
  - `app/api/capture/route.ts:130`
  - `app/api/plexo/scl-nodes/route.ts:36`
  - `app/api/notes/[id]/route.ts:51`
  - `app/api/notes/route.ts:47`
  - `lib/auto-categorize.ts:92`
- `pnpm typecheck` clean. `pnpm test` no regression.

**Dependencies:** Phase 2 published to npm.
**Context budget:** ≤15%.
**Subagents:** none — direct edits.
**Exit criteria:**
- Nexalog typecheck clean.
- Manual smoke: capture a note in dev → confirm 200 response from `/api/v1/scl/mutate` in API logs.
- Nexalog pushed to origin.

### Phase 4 — Smoke + close-out
**Scope:**
- Deploy nexalog to VPS (per service memory).
- Tail nexalog + plexo-api logs for 5 min after deploy. Confirm:
  - No `scl/*` 404s (was the silent-fail symptom).
  - No `scl/*` 401s (service-key wired correctly).
  - At least one successful `scl/mutate` from a real capture.
- Update `/home/dustin/dev/joeybuilt/plexo/packages/sdk/plan.md` open-items to mark "SCL endpoints" as resolved.
- Update ADR 0006 follow-ups list (the line that names this gap).

**Dependencies:** Phase 3 deployed.
**Context budget:** ≤10%.
**Exit criteria:** prod logs clean, ADR 0006 + SDK plan refer to this work as done.

## One-way doors

- ⚠ **Phase 2 npm publish** — irreversible. Operator gate.
- ⚠ **Phase 1 schema mutations** — none planned (only reads + jsonb updates). If the design ends up needing a column add, that becomes a one-way door — flag and gate.

## Operator sign-off gates

- After Phase 1 PR ready, before merge: confirm service-key auth choice (Security vs Operability conflict in ADR 0008).
- After Phase 2 build + version bump, before `npm publish`.
- After Phase 3 typecheck clean, before pushing to origin (auto-deploy daemon picks up push).
