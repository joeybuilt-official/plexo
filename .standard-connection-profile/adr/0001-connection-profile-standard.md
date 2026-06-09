# ADR 0001 — Plexo Connection & Profile Standard

Status: **PROPOSED — awaiting operator approval (one-way door).** No code until approved.
Date: 2026-06-09
Context inputs: Phase 0 audit, Phase 1 OSS benchmark, Phase 2 expert panel + 4 operator decisions.

## Decision summary (operator-ratified Phase 2)
1. Discovery ladder = configured → reuse-running → **launch-local (enabled in ALL topologies)**.
2. App capability scope = **explicit operator approval**, default-deny, per app×workspace.
3. Tool registration = **two-tier**: Plexo-owned generic *core connectors* (static) + app-owned *domain tools* (runtime over Pex).
4. Service-absent = **per-operation-class**: interactive→fail-loud, background→queue+retry, connect→backoff-then-loud.

## Invariant (restated, binding)
"Routes through Plexo" = **execution, not ownership.** Core owns intelligence primitives + the agent/execution loop (domain-agnostic). Apps own domain logic + domain tools, registered at runtime over Pex and torn down per session. **No app-specific domain knowledge may live in Plexo Core.** Apps depend on the Pex client package, never on Plexo Core internals.

---

## 1. Connection contract
**Resolution order (the client runs this ladder):**
1. **Configured endpoint** — `PLEXO_URL` (env) or `createPlexoClient({ plexoUrl })`. If set, use it; do not probe further.
2. **Reuse running** — if no explicit URL, check a well-known local instance descriptor (a lockfile at an OS-conventional path, e.g. `$XDG_RUNTIME_DIR/plexo/instance.json` containing `{url, pid, contractVersion, startedAt}`) and a well-known default port; if a healthy instance answers `GET /api/health`, attach to it.
3. **Launch-local** — if none reachable, spawn a local Plexo, wait for it to write its descriptor + pass health, then attach. **Single-writer guard (fallback for the operator's full-launch-local choice):** acquiring the instance is gated by an OS file lock on the descriptor path AND a Postgres advisory lock on the workspace DB; a second process that loses the race MUST attach to the winner, never run a second writer. Secrets for a spawned instance come ONLY from an explicit secret source (OS keychain or a path the launcher already trusts) — the launcher never materializes provider keys to disk/env itself.

**Endpoint config shape:** `{ plexoUrl: string; serviceKey: string; serviceKeyVersion?: string; appId: string; contractVersion: string }`. Discovery never puts secrets in URLs/query strings.

**Well-known descriptor** supersedes today's unused `WellKnownPlexo` spec (sdk/types/discovery.ts) — promote it from aspirational to the rung-2 mechanism.

## 2. Pex client contract (minimal surface — interface only)
The app depends ONLY on this interface from `@joeybuilt/plexo-sdk/connect` (already largely exists; this formalizes + version-stamps it):
```
interface PlexoClient {
  // lifecycle
  connect(): Promise<NegotiatedSession>      // runs resolution ladder + handshake (§3/§4)
  testConnection(): Promise<{ ok; latencyMs }>
  // intelligence (execution, not ownership)
  aiComplete(workspaceId, opts): Promise<...>
  chatMessage(workspaceId, userId, opts): Promise<...>
  agents.runCustom(workspaceId, opts): Promise<...>
  visionOcr(workspaceId, imageUrl): Promise<...>
  // memory / graph
  storeMemory / searchMemory / addEpisode / searchFacts
  // tools the app SUPPLIES (§4)
  registerTools(defs: ToolDefinition[]): SessionToolHandle   // scoped, torn down on session end
  // inbound (Plexo → app) HMAC-verified webhooks
  inbound(handlers): RequestHandler
}
```
Stable, additive-within-major. The app NEVER imports `@plexo/agent`/`@plexo/db`/core internals. (Enforced by lint guard — §pre-mortem fallback.)

## 3. Profile contract
- **Declaration:** at `connect()`, the client sends `{ appId, contractVersion, requestedProfile: { connectors: string[], capabilities: Capability[] } }`. Reuses the capability vocabulary in `packages/sdk/src/types/manifest.ts` (one vocabulary for connectors + capabilities).
- **Negotiation:** server computes **effective profile = intersection(requestedProfile, grantedProfile(app×workspace))** and returns it in `NegotiatedSession`. Unknown capability names are ignored (forward-compat, P2/P3).
- **Grant source (operator decision #2):** `grantedProfile` lives server-side in a new `workspace_app_grants` table (app×workspace → allowed connectors/capabilities), **default-deny**. Only the operator can widen a grant (UI + API). The client's request is a REQUEST, never authoritative.
- **Enforcement (P6):** server enforces the effective profile on EVERY call (tool invocation, connector access, capability use), not just at connect. A call outside scope → `PROFILE_SCOPE_EXCEEDED` (403-class). An unenabled connector costs zero footprint + zero UX (hand-off intent).
- **Adoption fallback (pre-mortem #2):** apps surface a clear "pending approval" state; a one-click operator approve UI; category default-profile templates; a dev-only `PLEXO_DEV_AUTOGRANT=1` (never honored in prod) so local dev isn't blocked.

## 4. Tool-registration contract (two-tier)
- **Tier A — core connectors (static, Plexo-owned):** generic, domain-agnostic integrations (GitHub/Slack/Linear/Notion/…) in `connections/registry.ts`. Allowed to stay compiled-in. **Boundary rule:** a core connector MUST NOT reference an app name or app-specific domain vocabulary. Enforced by a CI drift-guard (the Phase-0 grep, automated) — fails the build if a new factory mentions fylo/fonto/frameforge/koforje/levio or domain nouns. (pre-mortem #3 fallback.)
- **Tier B — app domain tools (runtime, app-owned):** the app registers tools at session start via `registerTools(defs)`:
  - **Declaration shape:** `{ name, description, paramsSchema (JSON-Schema), invokeUrl | bridgeWorker }` — same shape as an MCP server tool (reuse, P1-deviation #1).
  - **Scoping:** registered for the workspace-session only; visible only to that app's calls; subject to the effective profile (§3).
  - **Execution locus:** the tool runs IN THE APP (out-of-process PEX worker or the app's HTTP endpoint); Plexo calls it over the wire and runs the loop. Tools NEVER execute in-core and NEVER persist past the session. Side-effecting verbs ride the existing one-way-door approval gate.
  - **Teardown:** torn down when the session/task completes; **re-registration on reconnect** (Dist requirement) if Plexo restarted mid-session.
- The 2 Phase-0 drift instances (Levio timezone in executor; Levio calendar prompt rule) are reclassified as Tier-B concerns and **must be extracted to the Levio bridge** as part of Phase 4.

## 5. Version-skew contract
- Every `connect()` carries `contractVersion` (semver). Server negotiates to a common major or returns `PROTOCOL_VERSION_UNSUPPORTED` (fail-loud, P3). Minor/additive skew → ignore-unknown (old app keeps working against newer server). Single version constant shared by SDK + server; additive-only within a major.

## 6. Service-absent contract (per-operation-class)
- **Interactive (aiComplete/chatMessage/visionOcr/searchMemory):** fail-loud with actionable error (`PLEXO_UNREACHABLE`); never fake intelligence or silently downgrade.
- **Background writes (storeMemory/addEpisode/publishEvent):** enqueue durably + retry on reconnect (reuse the inngest substrate).
- **Connect/registration:** retry-with-backoff (SDK already has this) then fail-loud.

## 7. Explicit dependency statement (binding)
Apps depend on `@joeybuilt/plexo-sdk` (the Pex client) — NEVER on `@plexo/agent`, `@plexo/db`, or any Plexo Core internal. Domain logic + domain tools live in the app and are registered over Pex. Plexo Core stays domain-agnostic. Violations are CI-enforced (import-boundary lint + drift-guard).

---

## Pre-mortem (assume it shipped and failed)
1. **Launch-local split-brain or secret leak** (heightened by the full-launch-local choice). → Fallback: single-writer file-lock + DB advisory-lock with mandatory attach-on-lose; secrets only from an explicit trusted source; health-gated attach; if lock unobtainable, dial-existing.
2. **Default-deny grant friction drives devs back to forking core.** → Fallback: pending-approval UX + one-click approve + category default profiles + dev-only autogrant.
3. **Two-tier ossifies the static registry → domain drift recurs.** → Fallback: CI drift-guard (app-name/domain-noun grep) on new core connectors + a documented "generic→core / app-specific→Tier-B" rule + periodic audit.

## Consequences
- Phase 4 (post-approval) builds: the resolution-ladder client + `connect()` handshake, the `workspace_app_grants` table + server-side profile enforcement, the `registerTools` session contract + reconnect re-registration, the CI import-boundary + drift guards, and extraction of the 2 Levio drift instances.
- Largely additive to the existing SDK + PEX surface; not a rewrite.

## HARD STOP
No code until the operator approves this ADR.
