# Plexo Extension Security Model

Status: canonical spec (D6 — agents plan)
Scope: PEX extensions (type `skill | tool | channel | connector | agent`) installed from the Hub or sideloaded locally
Audience: host implementers, extension authors, workspace owners
Related: `docs/pex/SPEC.md` §5, §13, §17, §19, §23 | `docs/agents-plan/MASTER.md` (D6)

---

## 0. Scope & Philosophy

A PEX extension can:

- make external API calls (network),
- read/write workspace memory, conversations, tasks,
- invoke user-connected tools (Notion, Slack, Stripe, etc.),
- run arbitrary code inside a sandbox worker,
- be authored by third parties and installed from `hub.getplexo.com`.

This document defines **seven layers of defense** that together let Plexo accept third-party extensions from the Hub without making every install a trust fall.

Guiding principles:

1. **Default deny.** Nothing runs until the user explicitly enables. No capability is granted that the manifest didn't declare. Every newly-installed extension is `enabled=false`.
2. **Capability over code review.** We trust the *declaration*, enforce it at runtime, and audit what actually happened. We do not attempt to statically prove extension code is safe.
3. **The user is the final authority.** Irreversible actions require human approval. The host never auto-approves `channel:send`, financial actions, or deletes when the extension wasn't already trusted.
4. **Workspace owner sets the policy.** Per-workspace policy can tighten the defaults but cannot loosen them below the host ceiling.
5. **Shippable in ≤2 phases.** Layers 1–5 map to Phases 7–8 of the agents plan. Layer 6 (trust tiers) is data-only. Layer 7 (workspace policy) is a single JSON column and a middleware.

---

## 1. Threat Model

### 1.1 Assets under protection

| # | Asset | Sensitivity | Owner |
|---|-------|-------------|-------|
| A1 | Connection credentials (`installed_connections.credentials`, encrypted) | Critical | Workspace |
| A2 | Workspace memory entries (`memory_entries`) | High | Workspace |
| A3 | Tasks, conversations, audit log | High | Workspace |
| A4 | External accounts the user connected (Slack, Gmail, Stripe…) — the extension's ability to act as the user on those services | Critical | User |
| A5 | The host process itself (env vars, filesystem, child process spawn) | Critical | Operator |
| A6 | Cross-extension isolation (one extension reading another's storage) | Medium | Operator |
| A7 | LLM context (sending workspace data to an LLM with workspace data means sending to an external model provider) | High | User |

### 1.2 Adversary classes

| Class | Capability | Motivation | Primary defence |
|-------|-----------|------------|-----------------|
| T1. Malicious third-party author | Publishes an extension with legitimate-looking manifest but hostile runtime code | Data exfil, credential theft, spam | Capabilities enforced at SDK boundary (Layer 5), egress logging (Layer 3), trust tier (Layer 6) |
| T2. Compromised legitimate extension | Previously trusted extension updated to hostile version | Supply chain | Signature verification on update (Layer 1), version pinning |
| T3. Prompt-injected agent | Legitimate extension, but the *LLM* invoking its tools was tricked by user content | Data exfil, irreversible action | Per-invocation approval (Layer 2), egress logging (Layer 3) |
| T4. Buggy extension | Honest mistake, exceeds declared scope | Data corruption, runaway cost | Sandbox limits (Layer 4), capability enforcement (Layer 5) |
| T5. Curious neighbour | User of the same host installs an extension to see another workspace's data | Unauthorised access | Process isolation + workspace scoping (Layer 4), RLS on DB |

### 1.3 Non-goals

- **We do not defend against a compromised host operator.** If the Plexo server is compromised, everything is.
- **We do not defend against the user themself.** If Dustin as workspace owner approves a destructive action, we execute it.
- **We do not attempt perfect network sandboxing.** Node worker threads share the host's network stack. Egress filtering is best-effort (outbound allowlist + logging), not cryptographic.
- **We do not statically analyse extension JavaScript.** Registry-side dep auditing (SPEC §12.3) happens at publish; runtime protection is capability/egress/audit based.

---

## 2. The Seven Layers

```
┌────────────────────────────────────────────────────────────────┐
│ L1  Pre-install review      (user sees and consents before)    │
│ L2  Per-invocation approval (escalation contract, Phase 8)     │
│ L3  Egress logging & audit  (every call recorded, Phase 7)     │
│ L4  Sandbox isolation       (worker thread, resource limits)   │
│ L5  Capability enforcement  (SDK boundary, already live)       │
│ L6  Trust tiers             (owner / verified / community)     │
│ L7  Workspace owner policy  (per-workspace overrides)          │
└────────────────────────────────────────────────────────────────┘
```

---

## 3. Layer 1 — Pre-install Review

### 3.1 What the host checks before accepting an install

Enforced in `apps/api/src/routes/extensions.ts POST /api/v1/extensions`:

1. **Manifest schema validation.** Already live via `validateManifest()` from `@plexo/sdk`.
2. **`minHostLevel` compliance check.** Already live.
3. **Workspace access check.** Already live via `ensureWorkspaceAccess`.

Add under this spec:

4. **Signature verification.** If `manifest.trust === 'verified'` or `'owner'`, host MUST verify the package signature against the registry's public key. `trust: 'community'` skips this step but is labelled as unsigned in the UI.
5. **Hash pinning.** Host records `packageSha256` at install and refuses to upgrade to a version whose hash isn't recorded in the registry response.
6. **Workspace policy gate.** Host consults `workspace.settings.extensionPolicy` (Layer 7) and may reject the install outright before showing the dialog.
7. **Capability ceiling per trust tier** (per `packages/sdk/src/types/trust.ts`). Capabilities exceeding the declared tier are rejected with `TRUST_CEILING_EXCEEDED`.

### 3.2 The install dialog (UX)

When the user clicks *Install* on the Hub card or `plexo ext install @scope/name`, the host returns a `manifest_preview` object and the UI renders an **Install Review** modal with five sections, in this fixed order:

1. **Identity.**
   - `displayName`, `author`, `version`, `license`
   - Trust tier badge: `Verified` (green shield), `Community` (yellow triangle), `Owner` (blue lock), `Local` (grey wrench)
   - `did` (if present) and signature status: `signed by @scope` / `unsigned`.

2. **What it will do.**
   - Human-readable rendering of `capabilities[]` grouped by pillar (see §3.3 below).
   - Host tools it will register (from a dry-run activate in sandbox — see §3.5).

3. **Where data goes.**
   - `dataResidency.sendsDataExternally` (bool)
   - `dataResidency.externalDestinations[]` — each row: hostname, purpose, data types
   - Warning banner if `sendsDataExternally: true` and the destination list is empty.

4. **Human oversight.**
   - `escalation.irreversibleActions[]` — each action the extension flags as requiring approval
   - `escalation.requestsStandingApprovals` (bool)

5. **Model & context.**
   - `modelRequirements.minimumContextWindow` (if present)
   - `modelRequirements.localModelAcceptable`
   - `modelRequirements.preferredProviders` (if present)

The user must click *Install* to insert the row. The row is inserted with `enabled=false`. Enabling triggers a second (lighter) confirmation: *"Enable {name}? It will start running in this workspace and may perform the actions listed above."*

### 3.3 Capability → human-readable mapping

The install dialog never shows raw capability tokens. It groups them:

| Token pattern | Shown as | Badge colour |
|---------------|----------|--------------|
| `memory:read:*` | "Read any memory in this workspace" | red |
| `memory:read:<entity>` | "Read {entity} records" | amber |
| `memory:write:<entity>` | "Create or update {entity} records" | amber |
| `memory:delete` | "Delete memory entries" | red |
| `channel:send`, `channel:send-direct` | "Send messages on channels you've connected" | amber |
| `tasks:create`, `tasks:read`, `tasks:read-all` | "Create/read tasks in this workspace" | amber |
| `connections:<service>` | "Act on your behalf on {service}" | amber |
| `storage:read`, `storage:write` | "Use its own private storage" | green |
| `events:subscribe`, `events:publish` | "Listen to/emit workspace events" | green |
| `ui:register-widget`, `ui:notify` | "Show widgets / notifications in the UI" | green |
| `audit:read` | "Read the workspace audit trail" (owner tier only) | red |
| `model:override` | "Choose which LLM model to run on" | amber |
| `entity:create|modify|delete:<type>` | "Create/modify/delete {type}" | amber |
| `self:read`, `self:write` | "Read/update your UserSelf profile" | amber |
| `identity:present` | "Act under its own identity (DID)" | green |
| `host:<host>:<cap>` | "Host-specific: {cap}" | amber |

The five required-consent badges (red / amber) trigger an expandable *Why does it need this?* section pulled from `manifest.description` and a per-capability explainer in `manifest.capabilitiesRationale[token]`. As of §13/Q4 the field is REQUIRED for `verified` and `owner` tier extensions on every non-trivial capability (see `packages/sdk/src/validation/manifest.ts` for the enforced list). Community extensions get a "no explanation provided" note in the dialog when rationale is missing.

### 3.4 What requires *explicit* consent checkbox

The user must tick a consent checkbox before the Install button activates if **any** of these are true:

- `trust !== 'verified'` and `trust !== 'owner'`
- Any red-badge capability in the list
- `dataResidency.sendsDataExternally === true`
- Any `connections:<service>` capability
- Trust tier is `community` and any external destination is not in the workspace's allowed-destinations allowlist (Layer 7)

Label: *"I understand that {displayName} will {top-3 things it will do} and I take responsibility for installing it."*

### 3.5 Activation dry-run

Before inserting the row, the host MAY run the extension's `activate(sdk)` in a throwaway worker with `workspaceId: 'preview'` to collect its registered tools, schedules, widgets, prompts, contexts. The output is shown in the install dialog as *"This extension will register: 3 tools, 1 schedule, 1 widget."* Errors during dry-run abort the install with `ACTIVATION_FAILED`.

Rationale: an extension that declares `schedule:register` but never calls `sdk.registerSchedule()` is less scary than one that does. The UI should reflect reality, not just the manifest.

---

## 4. Layer 2 — Per-invocation Approval (Escalation)

Types already defined in `packages/sdk/src/types/escalation.ts`. This section defines enforcement.

### 4.1 What triggers escalation

The host MUST check every tool call against the escalation triggers below and, if any match, pause execution and raise an escalation request. Triggers are OR'd — any match escalates.

| Trigger | Check |
|---------|-------|
| `IRREVERSIBLE_ACTION` | Tool name (after `plugin__<scope>__<name>` normalisation) matches any entry in the extension's `manifest.escalation.irreversibleActions[]`, OR the tool uses a capability in the host's global irreversibility list: `channel:send`, `channel:send-direct`, `memory:delete`, `entity:delete:*`, `connections:<financial services>` |
| `HIGH_VALUE_ACTION` | Tool input contains a field named `amount`, `price`, `total`, or `value` whose numeric value exceeds `workspace.settings.escalationHighValueThreshold` (default 100, unit is the workspace's configured currency) |
| `CAPABILITY_EXPANSION` | Extension calls `sdk.capability.request(token)` for a token not in its install-time grant. Always escalates, always requires owner approval. |
| `CROSS_BOUNDARY` | Tool operates on an entity whose `ownerUserId` differs from the task invoker's |
| `CONFIDENCE_BELOW` | Primary agent's planner confidence for this step < `workspace.settings.escalationConfidenceThreshold` (default 0.6) — agent-specific, only active after Phase 9 |
| `NOVEL_PATTERN` | Tool+argument shape hash not seen in the last 90 days of audit log for this workspace + extension |

`IRREVERSIBLE_ACTION` and `CAPABILITY_EXPANSION` are mandatory at all compliance levels (§SPEC 13). The others are optional.

### 4.2 Escalation flow

1. Host detects trigger *before* dispatching the tool call to the worker.
2. Host writes an `extension_audit_log` row with `action='escalation_request'`, `outcome='pending'`.
3. Host emits an SSE event on the workspace stream: `topic='escalation.pending'`, payload is an `EscalationRequest` (see `packages/sdk/src/types/escalation.ts`).
4. Host **holds the extension's tool promise open** (does not reply to the worker) until:
   - A user response arrives → resolve with the result of continuing or denying
   - The standing-approval cache matches → same as above, automatic
   - Timeout (`workspace.settings.escalationTimeoutMs`, default 300_000) → resolve with `denied` and outcome `escalation_timeout`
5. User response is recorded in `extension_audit_log` with `action='escalation_approve'|'escalation_reject'|'escalation_timeout'` and `outcome='success'|'denied'|'timeout'`.

### 4.3 Where the UI lives

- **Inbox widget on the chat pane.** A pending escalation raises a card in the active conversation: *"{extension} wants to {action}. Context: {context}. [Approve] [Deny] [Approve and remember]."*
- **Persistent notifications drawer.** The `/app` shell has a notifications button. A pending escalation increments its badge and lists the request in the drawer.
- **Standing approvals page.** `/app/agents → Escalation` tab lists all `standing_approvals` rows and lets the user revoke or expire them.

Approve-and-remember inserts a row into `standing_approvals` with the matched `actionPattern` (e.g. `channel:send to @user/ops:*`) and `createdBy='user'`. Standing approvals are **user-owned**; extensions cannot create them.

### 4.4 Configuration surface

Per-workspace, stored in `workspace.settings.escalationPolicy`:

```ts
interface EscalationPolicy {
  highValueThreshold: number        // default 100
  confidenceThreshold: number       // default 0.6
  timeoutMs: number                 // default 300000
  novelPatternLookbackDays: number  // default 90
  requireApproverRole: 'owner' | 'admin' | 'member'  // default 'admin'
}
```

Per-extension: the manifest declares `escalation.irreversibleActions` (author) and the host has a **global irreversibility list** (operator). Globals always apply; manifest-declared ones add to them.

### 4.5 Anti-splitting rule

Per `docs/pex/SPEC.md` §23 (and `packages/sdk/src/types/escalation.ts`), extensions MUST NOT bypass escalation by decomposing one irreversible action into smaller ones. Enforcement: the host maintains a **composite action window** — if two or more reversible actions within a 10-second window combine to an irreversible effect (e.g. `memory:write` followed by `channel:send` that references the memory), the host treats the composite as irreversible. This is a best-effort heuristic; the initial implementation only checks the global irreversibility list.

---

## 5. Layer 3 — Egress Logging & Audit

### 5.1 What gets logged

Every tool call, every SDK bridge call, every external HTTP request made by an extension is logged. The existing `extension_audit_log` table (defined in `packages/db/src/schema.ts` and used by `packages/agent/src/audit.ts`) is the single source of truth. No new table.

Log shape (already exists — not changing):

```ts
{
  id: uuid
  workspaceId: uuid
  extensionId: text            // extension's manifest name, e.g. "@acme/slack"
  agentId: text | null
  sessionId: text              // task session or "activation"
  action: text                 // see §5.2
  target: text                 // tool name, domain, or "activate"/"deactivate"
  payloadHash: text            // sha256 of the JSON-encoded payload, not the payload itself
  outcome: text                // "success" | "failure" | "denied" | "timeout"
  modelContext: jsonb | null
  escalationOutcome: text | null
  createdAt: timestamp
}
```

Additions this spec requires (extend existing `extension_audit_log` via migration):

- `durationMs: integer` — already returned in `InvokeResult`, just needs to be persisted.
- `bytesSent: integer` — for egress rows only.
- `bytesReceived: integer` — for egress rows only.
- `statusCode: integer` — for egress rows only.
- `domain: text` — for egress rows only (already storable in `target` but a dedicated column enables indexing).

### 5.2 Action taxonomy

| action | Emitted when | Payload |
|--------|--------------|---------|
| `extension_activate` | Worker successfully runs `activate(sdk)` | `{ version, toolCount }` |
| `extension_deactivate` | User disables or uninstalls | `{ reason }` |
| `extension_crashed` | Worker error/exit code ≠ 0 | `{ error }` |
| `tool_invoke` | Tool call starts | `{ toolName, argsHash }` |
| `tool_result` | Tool call succeeds | `{ toolName, durationMs }` |
| `tool_error` | Tool call throws | `{ toolName, error, durationMs }` |
| `tool_timeout` | Tool call exceeds timeout | `{ toolName, timeoutMs }` |
| `tool_denied` | Capability check fails | `{ toolName, capability }` |
| `egress_request` | Extension makes an outbound HTTP call | `{ method, domain, bytesSent, bytesReceived, statusCode, durationMs }` |
| `memory_read` / `memory_write` / `memory_delete` | SDK bridge call | `{ entityType, itemCount }` |
| `connection_credential_access` | `sdk.connections.getCredentials(service)` | `{ service }` |
| `escalation_request` / `escalation_approve` / `escalation_reject` / `escalation_timeout` | See §4 | `{ trigger, action }` |

### 5.3 Retention

- Default: 90 days (per workspace setting `auditRetentionDays`).
- Owners MAY raise retention up to 365 days.
- Rows older than retention are deleted by a nightly job. Deletes are not audited (they're deletions of audit rows, not actions).

### 5.4 User visibility

- **Per-extension audit pane.** `/app/agents → select extension → Audit tab` (wired in Phase 7 per MASTER.md). Filters: action, outcome, date range, target domain. Exportable as CSV.
- **Workspace audit page.** `/app/audit` — existing route. Add a filter `?extensionId=<name>` and a filter pill "Extensions only".
- **Egress summary card.** On the workspace dashboard, show a 7-day sparkline of external bytes sent by extensions, with the top 3 domains. Owners only.

### 5.5 What we do NOT log

- **Payload contents.** Only `sha256(JSON.stringify(payload))` is stored, as today. The hash lets us correlate "same input → same output" without retaining PII.
- **Credentials.** Never. If a credential leaks into a `target` or `payload`, the logger MUST redact (see `apps/api/src/routes/oauth.ts` redaction pattern — F2 in `docs/security/findings.md`).
- **LLM prompt text.** The LLM conversation is logged separately in `conversations`. Extension audit does not duplicate it.

### 5.6 Egress capture mechanism

Extensions run in Node worker threads that share the host's network stack. To capture egress without rewriting every extension:

1. **Injected fetch wrapper.** The activation SDK (`packages/agent/src/plugins/activation-sdk.ts`) injects a `sdk.http.fetch(url, opts)` method. Extensions are expected to use this instead of the global `fetch`. The wrapper records the egress row before returning.
2. **Global `fetch` monkey-patch inside the worker.** Best-effort — `sandbox-worker.ts` replaces `globalThis.fetch` with a wrapper that (a) checks the domain against `dataResidency.externalDestinations`, (b) logs the egress, (c) forwards. An extension can bypass this by using `http.request` or similar Node core modules. Layer 4 (resource + allowlist enforcement) is what makes bypass *detectable*; Layer 3 gives us the *log*.
3. **Outbound allowlist enforcement.** At *Standard* compliance the allowlist is advisory and logged-only. At *Full* compliance the worker is spawned with a NODE_OPTIONS that routes all HTTP through a host-controlled agent that enforces the allowlist. Version 1 ships *Standard*.

---

## 6. Layer 4 — Sandbox Isolation

Existing implementation: `packages/agent/src/plugins/persistent-pool.ts` + `sandbox-worker.ts`. One Node `worker_threads.Worker` per extension, long-lived, reused across invocations.

### 6.1 What the sandbox guarantees

| Guarantee | How | Notes |
|-----------|-----|-------|
| **Process isolation** | `worker_threads` — separate V8 isolate, own heap, own event loop | Workers share the host process's file descriptors; see below |
| **No access to host process memory** | V8 isolates | Guaranteed |
| **No access to host env vars** | Worker is spawned without inheriting `process.env` (current code DOES inherit — see §6.2 gap) | **Gap: Phase 7 fix** |
| **No child process spawn** | Worker code uses `require('child_process')` → Node allows it | **Gap: Phase 7 fix via `--disable-proto` + permission model OR a prelude that deletes `child_process` from `require.cache`** |
| **No filesystem writes outside storage API** | Worker has `fs` available | **Gap: best-effort via prelude, real fix is Node's `--permission` flag (experimental)** |
| **Tool-call timeout** | `invokeTool()` — kills worker on timeout | Live |
| **Activation timeout** | `getWorker()` — 30s default | Live |
| **Resource limits** | `resourceHints.maxMemoryMB/maxCpuShares/maxInvocationMs` in manifest | Memory enforced via `Worker({resourceLimits: {maxOldGenerationSizeMb}})` — **Phase 7 addition** |
| **Cross-extension isolation** | Storage keys prefixed `ext:<pluginName>:<key>`, memory entries tagged `authorExtension` | Live for storage; memory is workspace-shared with attribution only |

### 6.2 What the sandbox does NOT guarantee

The honest list:

1. **Network isolation.** The worker can reach any host the Node process can reach. Egress filtering is logging-only at Core/Standard compliance.
2. **Filesystem isolation.** `fs` is importable. A hostile extension can read any file the Node user can read. Mitigation: run the Plexo server as a non-privileged user; never mount secrets into the app's CWD; don't set env vars the extension shouldn't see.
3. **`child_process` / `worker_threads` spawn.** A hostile extension can recurse. Mitigation: resource limit on total process count per workspace (Phase 7).
4. **CPU starvation.** Worker threads share the host's CPU scheduler. A busy loop in one extension slows down others. Mitigation: `resourceLimits.cpuShares` is documentary until we move to process isolation.
5. **Memory pressure.** Worker heap is bounded by `maxOldGenerationSizeMb`, but V8 has headroom on top of that.
6. **Prompt injection.** Out of scope for sandbox. The LLM invoking the tool is a separate trust boundary (see Layer 2).

### 6.3 Threat model mapping

Against T1 (malicious third-party author):
- Layer 5 stops capability abuse (can't call `memory:read` without the token).
- Layer 4 *does not* stop file read / fork bomb / credential exfil via side channels. The operator must treat the server as running untrusted code at the privilege level of the `plexo` user.

Recommendation for operators: run Plexo inside a Docker container with a dedicated non-root user, `read_only: true` filesystem (except `/tmp` and the Plexo data volume), no mounted host paths, and an outbound egress firewall limiting the container to (a) the DB/Redis, (b) allowlisted LLM providers, (c) the OAuth callback domains for installed connections.

---

## 7. Layer 5 — Capability Enforcement

Already live. Implementation: `packages/agent/src/plugins/activation-sdk.ts` `createActivationSDK()`. Every SDK method gates on `capSet.has(token)` before calling the bridge.

### 7.1 Grant flow

1. User installs the extension. Manifest's `capabilities[]` is copied into `extensions.manifest.capabilities` in DB.
2. When the worker activates, the host passes `permissions: capabilities` into `getWorker()`.
3. Sandbox constructs `createActivationSDK(name, capabilities, settings, workspaceId, bridge)`.
4. Every `sdk.*` call first checks `capSet.has(token)`. Missing token → throws `CAPABILITY_DENIED`, which surfaces to the tool caller as a tool error, and to the audit log as `tool_denied`.

### 7.2 Revocation flow

Per-capability revocation is **not supported at the row level** today (capabilities are read from `manifest`, which is immutable per install). This spec adds:

Add an `extensions.grantedCapabilities` nullable `text[]` column. If present, it overrides `manifest.capabilities` when the worker activates. Revocation = remove the token from this array and terminate the worker; re-activation loads with the narrower set.

UX: on the extension detail pane (Phase 4), a capabilities list with a toggle per capability. Disabling a toggle triggers a confirmation: *"Revoking {capability} will stop {extension} from doing {effect}. It will restart with the remaining permissions. Continue?"*

### 7.3 Default-deny

The SDK has no blanket "allow all" mode. An extension with an empty `capabilities[]` cannot call any SDK bridge method. It can still register tools (tools themselves require no capability to register — that's the entry point). A zero-capability tool that uses `fetch` directly is still captured by Layer 3 egress logging.

### 7.4 Capability token additions from this spec

Two new optional tokens (not blocking — added when needed):

- `net:<domain>` — declares an intent to reach a specific domain. Not yet enforced; used only in the install dialog to surface destinations ahead of `dataResidency.externalDestinations`.
- `model:<provider>` — declares that the extension will invoke an LLM through a connection. Today this is covered by `connections:<provider>`; `model:*` is reserved.

These are **not required** for Phase 7/8 launch. Noted here so the install dialog has room to surface them once authors adopt.

---

## 8. Layer 6 — Trust Tiers

Types defined in `packages/sdk/src/types/trust.ts`. Ceilings already expressed in `TrustTierCeilings`. This section defines **how tiers are assigned**, **how they map to UX**, and **what the host actually enforces**.

### 8.1 Tier assignment

| Tier | Who assigns | How |
|------|-------------|-----|
| `owner` | The host operator (Dustin) | Manifest has `trust: 'owner'`. Host verifies the package signature against `TrustTierPolicy.ownerSigningKeyId`. Only extensions built and signed by the host operator qualify. |
| `verified` | Plexo extension registry (Hub) | Manifest has `trust: 'verified'`. Registry has reviewed the source, verified the signing key belongs to a known publisher, and stamped the package with a signature chained to the registry's root. Host verifies against `TrustTierPolicy.registryEndpoint`. |
| `community` | Default for published-to-Hub extensions that aren't verified | Manifest may omit `trust` entirely, or declare `trust: 'community'`. Registry does basic malware/dep scanning (SPEC §12.3) but no human review. |
| `local` | Sideloaded extensions (via `POST /api/extensions` with a manifest payload, or `plexo ext install ./path`) | Not a first-class PEX tier. Host tags the install record with `source='sideloaded'` and treats it *for UX purposes* as if the user is the author. Capabilities are still enforced. |

### 8.2 Capability ceilings (from `trust.ts`)

| Capability | owner | verified | community | local |
|------------|:-----:|:--------:|:---------:|:-----:|
| Wildcard memory (`memory:read:*`) | yes | **no** | no | yes |
| `audit:read` | yes | no | no | yes |
| Entity creation | yes | yes | **no** | yes |
| `model:override` | yes | no | no | yes |
| `connections:<service>` | auto | auto | **require user confirmation per service** | auto |
| `channel:send`, `channel:send-direct` | auto | auto | **require user confirmation** | auto |
| Irreversible action escalation | per manifest | per manifest | always, regardless of manifest declaration | per manifest |

"auto" = the capability is granted at install because the user clicked Install. "require user confirmation" = the install dialog shows an extra per-capability checkbox.

### 8.3 UX mapping

- **`owner`** — blue `Plexo Official` badge. Install dialog is minimal ("You're installing an extension built by Plexo").
- **`verified`** — green `Verified Publisher` badge. Install dialog shows full permission list but no extra warnings.
- **`community`** — yellow `Community` badge. Install dialog shows full permission list + the yellow banner *"This extension has not been reviewed by Plexo. You are responsible for verifying it does what it claims."* + required checkbox (§3.4).
- **`local`** — grey `Sideloaded` badge. Install dialog shows *"You uploaded this extension directly. Capabilities and actions are your responsibility."* + required checkbox.

### 8.4 Tier cannot be forged

`manifest.trust` is a *claim*. The host MUST verify via
`verifySignature(manifest, meta)` from `@plexo/sdk`
(`packages/sdk/src/validation/signature.ts`):

1. For `owner`: Sigstore signature with `signerIdentity` ending in
   `@joeybuilt-official` (v1 stub check). Real implementation uses
   `cosign verify` against the Rekor log. If verification fails, downgrade
   to `community` and log a warning.
2. For `verified`: Sigstore signature or ECDSA-P256 signature with an
   identity in the registry's verified-publisher set. If not, downgrade to
   `community`.
3. For `community` or absent: no verification.
4. For sideloaded installs (no Hub): `POST /api/v1/extensions/sideload`
   strips `manifest.trust` from the request body before validation and
   stores `__plexoSideload.effectiveTrust: 'local'` on the row. Tier claims
   from sideload manifests are never honored.

---

## 9. Layer 7 — Workspace Owner Controls

Workspace policy is stored in `workspace.settings.extensionPolicy` (single JSON column; no new table):

```ts
interface ExtensionPolicy {
  // Install gating
  allowedTrustTiers: Array<'owner' | 'verified' | 'community' | 'local'>
  // default ['owner', 'verified', 'community', 'local']

  requireAdminApprovalForInstall: boolean
  // default false (solo-operator default). When true, any non-owner member
  // who initiates an install creates a pending install request instead of
  // an extension row; an admin must approve.

  // Capability gating
  blockedCapabilities: string[]
  // default [] — tokens in this list are rejected at install, even if declared

  // Egress gating
  allowedEgressDomains: string[] | null
  // default null = allow all. When non-null, extensions cannot declare
  // externalDestinations outside this set at install, and Layer 3 flags
  // egress to out-of-list domains as policy violations.

  // Escalation gating
  alwaysEscalate: string[]
  // capability tokens or tool name globs that ALWAYS require approval,
  // regardless of the extension's manifest declaration

  escalationPolicy: EscalationPolicy  // see §4.4

  // Memory gating
  requireApprovalForMemoryAccess: boolean
  // default false. When true, the first time an extension reads or writes
  // memory it triggers a CAPABILITY_EXPANSION-style escalation.

  // Audit retention
  auditRetentionDays: number // 30..365, default 90
}
```

### 9.1 Enforcement points

- **Install.** `apps/api/src/routes/extensions.ts POST /` checks `allowedTrustTiers`, `blockedCapabilities`, `allowedEgressDomains` before inserting the row. Violations return 400 `POLICY_VIOLATION`.
- **Enable.** `PATCH /:id { enabled: true }` re-runs the install gating — the manifest could have been edited in the DB by a sibling extension (defence-in-depth; should never happen in practice).
- **Run.** The executor's tool wrapper (`packages/agent/src/plugins/bridge.ts loadPluginTools`) passes the workspace policy into `invokeTool` via the worker handle, and the Layer 2 escalation check consults `alwaysEscalate` and `requireApprovalForMemoryAccess`.
- **Audit retention.** Nightly cron deletes `extension_audit_log` rows older than `auditRetentionDays`.

### 9.2 Who can edit the policy

- `workspace.settings.extensionPolicy` is edited on `/app/workspace-settings → Security` (new subsection).
- Only `role='owner'` members can edit.
- Changes are themselves audited (`audit_log` table, action `workspace.policy.update`).

### 9.3 Common policy recipes

**Solo operator (Dustin's default):**
```json
{
  "allowedTrustTiers": ["owner", "verified", "community", "local"],
  "requireAdminApprovalForInstall": false,
  "blockedCapabilities": [],
  "allowedEgressDomains": null,
  "alwaysEscalate": ["channel:send", "memory:delete"],
  "requireApprovalForMemoryAccess": false,
  "auditRetentionDays": 90
}
```

**Paranoid (team workspace, high sensitivity):**
```json
{
  "allowedTrustTiers": ["owner", "verified"],
  "requireAdminApprovalForInstall": true,
  "blockedCapabilities": ["memory:read:*", "audit:read", "model:override"],
  "allowedEgressDomains": ["api.anthropic.com", "api.openai.com", "slack.com"],
  "alwaysEscalate": ["channel:send", "memory:write:*", "entity:delete:*", "connections:*"],
  "requireApprovalForMemoryAccess": true,
  "auditRetentionDays": 365
}
```

**Demo mode (public-facing workspace, read-only):**
```json
{
  "allowedTrustTiers": ["owner"],
  "requireAdminApprovalForInstall": true,
  "blockedCapabilities": ["channel:send", "channel:send-direct", "memory:delete", "entity:delete:*"],
  "allowedEgressDomains": [],
  "alwaysEscalate": ["memory:write:*"],
  "requireApprovalForMemoryAccess": true,
  "auditRetentionDays": 30
}
```

---

## 10. Default Host Policy (Out of the Box)

If no workspace policy is set, Plexo applies:

- `allowedTrustTiers = ['owner', 'verified', 'community', 'local']`
- `blockedCapabilities = []`
- `allowedEgressDomains = null` (all allowed, logged)
- `alwaysEscalate = ['channel:send', 'channel:send-direct', 'memory:delete', 'entity:delete:person', 'entity:delete:transaction']`
- `auditRetentionDays = 90`
- `escalationPolicy.timeoutMs = 300_000` (5 min)

Even with the loosest policy:

- `extensions.enabled` defaults to `false`.
- Every install requires the user to click Install in the dialog.
- Every enable requires a second confirmation.
- `IRREVERSIBLE_ACTION` and `CAPABILITY_EXPANSION` triggers always escalate.
- `owner` tier is validated by signature; claims cannot be faked.

---

## 11. Enforcement Points in the Codebase

| Layer | File | Method / hook | Status |
|-------|------|---------------|--------|
| L1 | `apps/api/src/routes/extensions.ts` | `POST /` — `validateManifest`, `minHostLevel`, **add: signature check, policy check** | Partial — add in Phase 7 |
| L1 | `apps/api/src/routes/extensions.ts` | `POST /sideload` — env-flag gate, owner-only, consent checkbox, trust coercion, egress allowlist, no auto-update | Live (this pass) |
| L1 | `packages/sdk/src/validation/signature.ts` | `verifySignature(manifest, meta)` — v1 stub, Sigstore-ready | Live (stub) |
| L1 | `packages/db/drizzle/0069_add_extension_signatures.sql` | signature / signer_identity columns on extension_registry | Live |
| L1 | `apps/web/src/app/app/marketplace/*/install-button.tsx` | Install dialog UI (incl. capabilitiesRationale rendering) | Needs build in Phase 7 |
| L2 | `packages/agent/src/plugins/bridge.ts` | `loadPluginTools` — wrap `invokeTool` with escalation pre-check | Phase 8 |
| L2 | `packages/agent/src/plugins/persistent-pool.ts` | `dispatchSdkCall('escalate', ...)` — currently throws `NOT_IMPLEMENTED` | Phase 8 |
| L3 | `packages/agent/src/audit.ts` | `logAuditEntry` + new egress fields | Extend in Phase 7 |
| L3 | `packages/agent/src/plugins/activation-sdk.ts` | New `sdk.http.fetch` wrapper | Phase 7 |
| L3 | `packages/agent/src/plugins/sandbox-worker.ts` | Monkey-patch `globalThis.fetch` for capture | Phase 7 |
| L4 | `packages/agent/src/plugins/persistent-pool.ts` | `getWorker` — pass `resourceLimits` from `manifest.resourceHints` | Phase 7 extension |
| L4 | `packages/agent/src/plugins/sandbox-worker.ts` | Prelude: delete `child_process` from require cache; strip env vars | Phase 7 |
| L5 | `packages/agent/src/plugins/activation-sdk.ts` | `createActivationSDK` — `capSet.has(token)` | Already live |
| L5 | `extensions` table + DB migration | Add `grantedCapabilities text[] null` | Phase 7 |
| L6 | `apps/api/src/routes/extensions.ts` | `POST /` — verify signature, stamp `trust` | Phase 7 |
| L6 | `apps/hub/src/*` | Registry signing + verified-publisher key set | Phase 7 (Hub side) |
| L7 | `apps/api/src/routes/extensions.ts` | Read `workspace.settings.extensionPolicy` on every install/enable | Phase 7 |
| L7 | `apps/web/src/app/app/workspace-settings/security/page.tsx` | Policy editor UI | Phase 7 |

---

## 12. What We're Not Doing (Explicitly)

These are deliberate omissions, not oversights:

1. **Static analysis of extension code.** Too expensive, too easy to evade. Capability enforcement + egress logging is the chosen posture.
2. **Process-level sandboxing** (separate OS process per extension). Node `worker_threads` is what we ship. Process isolation is the v1.0 hardening when we move beyond solo-host deployments.
3. **gVisor / firecracker / wasm-based sandbox.** Not in scope for v0.4. Revisit after Phase 10.
4. **Per-capability time-boxed grants** ("allow `channel:send` for the next 10 minutes"). Revisit if users ask for it; today the primitive is revocation + re-enable.
5. **Cross-workspace extension sharing.** Extensions are per-workspace. A central "admin approves an extension for the whole org" flow is future work (MASTER.md D5 recommends keeping per-workspace for v0.4).

---

## 13. Resolved Questions

All four open questions from D6 were answered and implemented in the security
hardening pass shipped alongside this spec.

### Q1 — Who holds the owner-tier signing key? (RESOLVED)

**Decision:** **Sigstore / cosign with GitHub OIDC** for v1. Keyless signing
tied to the GitHub Actions workflow that publishes to the registry. No
long-lived private key to lose, rotate, or accidentally commit.

**How it works:**

1. The publish pipeline (GitHub Actions in `joeybuilt-official/plexo`) calls
   `cosign sign-blob --yes` against the SHA-256 of the manifest, producing a
   Sigstore bundle that encodes the OIDC identity of the workflow
   (`plexo-bot@joeybuilt-official` or similar).
2. That bundle is sent to the Hub's publish endpoint in the `signature`
   field alongside `signatureType: 'sigstore'` and the `signerIdentity`.
3. The registry persists all four fields on the `extension_registry` row.
4. At install time, the host calls `verifySignature(manifest, meta)` from
   `@plexo/sdk` (file: `packages/sdk/src/validation/signature.ts`). The v1
   implementation is a **stub** — it accepts any Sigstore bundle whose
   `signerIdentity` ends in `@joeybuilt-official` or `@plexo-official` as
   owner-tier, and anything else Sigstore-signed as verified-tier. Real
   cosign verification against the Rekor transparency log is a follow-up —
   the call site is already wired so the swap is a one-file change.

**Fallback:** If Sigstore proves too heavy for a particular publish flow, the
same helper accepts `signatureType: 'ecdsa-p256'`. The private key lives in
1Password; the public key is embedded in the host. This path is present but
unused for v1.

**Stubbed for v1, real later:**

- The `verifySignature()` stub does not call `cosign verify` — it trusts the
  `signerIdentity` claim. Swap-in target is
  [`@sigstore/verify`](https://www.npmjs.com/package/@sigstore/verify).
- No Rekor log lookup. A compromised registry could insert a forged row.

### Q2 — Hub registry signing pipeline support? (RESOLVED)

**Investigation result:** The Hub had **zero** signing support before this
pass. `apps/api/src/routes/registry.ts POST /` inserted the manifest JSON
and nothing else. `extension_registry` had no signature columns.

**Implemented:**

1. **Migration `0069_add_extension_signatures.sql`** adds four nullable
   columns: `signature`, `signature_type`, `signer_identity`, `signed_at`,
   plus an index on `signer_identity`.
2. **Registry publish endpoint** (`apps/api/src/routes/registry.ts`) accepts
   the new fields in the POST body, validates them as a group (all or
   none), and writes them onto the row on both insert and update paths.
3. **Pre-existing rows** stay `NULL`. They surface in the Hub UI as
   `unverified` and the install dialog downgrades them to community tier
   until the publisher re-signs.
4. **`verifySignature()` helper** in `@plexo/sdk` exports the stub verifier
   alongside the types. Install routes call it before trusting
   `manifest.trust`.
5. **Stub agents already in the registry** (`research-agent`,
   `content-agent`, etc.) are treated as `community` until re-published
   through the signed pipeline. Phase 5's re-seed job should be updated to
   pass signature fields.

**Stubbed for v1, real later:**

- GitHub Actions workflow that produces the Sigstore bundle and calls the
  publish endpoint. Manual re-seed for now.
- Registry-side verification at publish time (today we trust whatever
  signature the publisher sends us — we only check it's well-formed).

### Q3 — Sideloaded extensions in production? (RESOLVED)

**Decision:** **Allowed, with eight hard guards and an env-flag kill switch.**

**Environment flag:** `ALLOW_SIDELOAD` (`.env.example`, `docker-compose.yml`).
Defaults to `false`. SaaS Plexo at `getplexo.com` ships with the flag OFF.
Self-hosted operators opt in by setting it to `true` in their `.env`.

**New endpoint:** `POST /api/v1/extensions/sideload` in
`apps/api/src/routes/extensions.ts`. Separate from the registry-install path
`POST /api/v1/extensions` so the guard logic is not tangled with normal
installs. Accepts `{ workspaceId, manifest, settings, consent: true }`.

**Guards, in order:**

1. **Env flag check.** `process.env.ALLOW_SIDELOAD !== 'true'` → 403
   `SIDELOAD_DISABLED`.
2. **Workspace owner only.** `requireWorkspaceMember` is not enough —
   `req.workspaceRole !== 'owner'` → 403 `OWNER_ONLY`. Super admins bypass.
3. **Explicit consent.** `consent !== true` in the body → 400
   `CONSENT_REQUIRED`. The UI install screen surfaces the warning
   *"This extension hasn't been reviewed by Plexo. Only install if you
   trust the source."* with a checkbox the user must tick.
4. **Trust tier coercion.** Any `manifest.trust` value from the sideload
   body is stripped BEFORE validation, so the validator's ceiling logic
   treats the request as `local`. The original value is preserved in
   `manifest.__plexoSideload.originallyDeclaredTrust` for audit.
5. **Capability ceiling.** `validateManifest(manifest, { source: 'sideload' })`
   rejects any `memory:read:*`, `memory:write:*`, `audit:read`, or
   `model:override` token. Enforced in
   `packages/sdk/src/validation/manifest.ts`.
6. **Egress allowlist, no wildcards.** If `dataResidency.sendsDataExternally`
   is true, `externalDestinations` must list every host literally — any
   `*.example.com` host is refused at install. An empty destination list
   with `sendsDataExternally: true` is also refused.
7. **No auto-update.** The manifest copy stored on the row is annotated with
   `__plexoSideload.autoUpdate: false` and `pinnedVersion` equal to the
   installed version. The Hub's update-checker ignores rows tagged this way.
8. **Audit stamping.** Every audit log row for a sideloaded extension
   includes `metadata.source: 'sideload'`. One-click disable is already
   available via the existing PATCH toggle.

**Runtime posture:** Sideloaded rows get `source='sideloaded'` in the
`extensions` table. The install dialog shows the grey `Sideloaded` badge.
All other runtime controls — capability revocation, egress blocks, pause,
uninstall — work identically.

### Q4 — `capabilitiesRationale` field? (RESOLVED — added)

**Decision:** Added to the PEX manifest schema as an optional field, enforced
at publish for verified/owner tier extensions.

**Schema:**

```ts
// packages/sdk/src/types/manifest.ts
capabilitiesRationale?: Record<string, string>
```

**Validator rules** (`packages/sdk/src/validation/manifest.ts`):

- Keys must appear in `capabilities[]`. Orphan keys error.
- Values must be 1–200 character strings.
- For `trust: 'owner'` and `trust: 'verified'`: REQUIRED for every
  non-trivial capability. "Trivial" means entries in
  `RATIONALE_OPTIONAL_CAPABILITIES`: `storage:*`, `events:*`, `ui:*`,
  `identity:present`, `prompts:*`, `context:*`, `schedule:register`. Missing
  rationale on a required capability is a hard error — the publish endpoint
  rejects with `INVALID_MANIFEST`.
- For `trust: 'community'`: optional. Missing rationale is a warning only,
  surfaced to the install dialog as *"no explanation provided"*.
- For `trust: 'local'` (sideload): optional, never enforced.

**Install dialog rendering** (Phase 7 UI implementation):

- Each requested capability renders with its rationale below in muted text.
- Capabilities without a rationale show `ⓘ no explanation provided` hint.
- High-risk capabilities (`memory:*`, `channel:send`, `connections:*`,
  `entity:delete:*`) are colour-coded amber/red per §3.3's existing table.

**Canonical example:** `extensions/core/research-agent/plexo.json` now
declares its capabilities with rationales as the reference for third-party
authors.

---

## 14. References

- `docs/pex/SPEC.md` §5 (Isolation), §13 (Security Requirements), §17 (Trust Tiers), §19 (Data Residency), §23 (Escalation)
- `packages/sdk/src/types/manifest.ts` — `ExtensionManifest`, `CapabilityToken`, `capabilitiesRationale`
- `packages/sdk/src/types/trust.ts` — `TrustTier`, `TrustTierCeilings`
- `packages/sdk/src/types/escalation.ts` — `EscalationTrigger`, `EscalationRequest`, `StandingApproval`
- `packages/sdk/src/types/data-residency.ts` — `DataResidencyDeclaration`
- `packages/sdk/src/validation/manifest.ts` — `validateManifest`
- `packages/sdk/src/validation/signature.ts` — `verifySignature` (v1 stub)
- `packages/agent/src/plugins/activation-sdk.ts` — capability enforcement
- `packages/agent/src/plugins/persistent-pool.ts` — sandbox + bridge
- `packages/agent/src/audit.ts` — audit logger
- `apps/api/src/routes/extensions.ts` — install / sideload / enable / uninstall
- `apps/api/src/routes/registry.ts` — Hub publish + signature ingest
- `packages/db/drizzle/0069_add_extension_signatures.sql` — signature columns
- `extensions/core/research-agent/plexo.json` — canonical `capabilitiesRationale` example
- `docs/security/findings.md` — prior audit (F1–F11)
- `docs/security/threat-model.md` — prior threat model
- `docs/agents-plan/MASTER.md` — phase plan, D6 decision
