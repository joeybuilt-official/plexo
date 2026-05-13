# PEX Agent Manifest

Reference for the `type: "agent"` variant of the Plexo Extension Protocol
(PEX) manifest. Uses `@plexo/research-agent` — the first installable
reference agent — as the running example.

Canonical types: `packages/sdk/src/types/manifest.ts`
Validator: `packages/sdk/src/validation/manifest.ts`

---

## Minimum viable agent

```json
{
  "plexo": "0.4.0",
  "name": "@you/my-agent",
  "type": "agent",
  "version": "1.0.0",
  "displayName": "My Agent",
  "description": "One-line description shown in the marketplace.",
  "author": "Your Name",
  "license": "MIT",
  "entry": "./dist/index.js",
  "capabilities": []
}
```

Anything beyond these fields is optional but strongly recommended for agents.

---

## The `@plexo/research-agent` example

The research agent ships in `extensions/core/research-agent/plexo.json`
and is bundled into the API container at
`/app/extensions/core/research-agent/dist/index.js`.

```json
{
  "plexo": "0.4.0",
  "name": "@plexo/research-agent",
  "type": "agent",
  "version": "1.0.0",
  "displayName": "Research Agent",
  "description": "Deep research with source gathering and cited summaries.",
  "author": "Plexo",
  "license": "AGPL-3.0-only",
  "entry": "/app/extensions/core/research-agent/dist/index.js",
  "minPexVersion": "0.4.0",
  "capabilities": ["storage:read", "storage:write", "ui:notify"],
  "trust": "verified",
  "modelRequirements": {
    "minimumContextWindow": 32000,
    "requiresFunctionCalling": true,
    "localModelAcceptable": false,
    "preferredProviders": ["anthropic", "openai"]
  },
  "escalation": {
    "irreversibleActions": [],
    "requestsStandingApprovals": false
  },
  "agentHints": {
    "taskTypes": ["research", "literature_review", "market_analysis"],
    "minConfidence": 0.65
  },
  "dataResidency": {
    "sendsDataExternally": true,
    "externalDestinations": [
      { "host": "duckduckgo.com", "purpose": "Web search (no API key)" }
    ]
  },
  "resourceHints": { "maxInvocationMs": 60000 }
}
```

---

## Field reference

### Required (core)

| Field | Description |
|-------|-------------|
| `plexo` | PEX spec version this manifest targets. Must be valid semver. |
| `name` | Scoped package name, `@scope/name`, lowercase alphanumeric + `-._`. |
| `version` | Agent version. Must be valid semver. |
| `type` | `"agent"`. |
| `entry` | Absolute path (or package-relative path) to the compiled `activate(sdk)` module. |
| `capabilities` | Array of capability tokens the agent requests. |
| `displayName` | Human-readable name shown in the marketplace. Max 50 chars. |
| `description` | Short one-liner shown in search and detail pane. Max 280 chars. |
| `author` | Publisher name or organization. |
| `license` | SPDX license identifier. |

### Agent-specific

| Field | Purpose |
|-------|---------|
| `agentHints.taskTypes` | Strings the primary agent uses to match tasks to this agent (Phase 6). |
| `agentHints.minConfidence` | Threshold below which the agent declines to act. |
| `escalation.irreversibleActions` | Tool names that need human approval before running. Enforced in Phase 8. |
| `escalation.requestsStandingApprovals` | Whether the agent requests a persistent approval grant. |
| `modelRequirements.minimumContextWindow` | Minimum usable context window in tokens. |
| `modelRequirements.requiresFunctionCalling` | Whether the agent needs tool-calling support. |
| `modelRequirements.localModelAcceptable` | Set to `false` to force a managed provider. |
| `modelRequirements.preferredProviders` | Ordered list: `anthropic`, `openai`, `google`, etc. |

### Trust and data

| Field | Purpose |
|-------|---------|
| `trust` | `"owner" \| "verified" \| "community"`. See §17. Host validates via signing key. |
| `dataResidency.sendsDataExternally` | `true` if the agent makes outbound requests. |
| `dataResidency.externalDestinations` | Array of `{ host, purpose }` declarations. Required when `sendsDataExternally` is `true`. |

### Resource hints

| Field | Purpose |
|-------|---------|
| `resourceHints.maxInvocationMs` | Soft cap on a single tool invocation. The worker will be terminated past this. |
| `resourceHints.maxMemoryMB` | Soft memory cap (advisory in v0.4). |
| `resourceHints.maxCpuShares` | Soft CPU cap (advisory in v0.4). |

---

## Capability reference (subset used by agents)

| Token | Grants |
|-------|--------|
| `storage:read` / `storage:write` | Per-extension KV via Redis. |
| `memory:read:<entity>` / `memory:write:<entity>` | Entity-scoped memory. |
| `ui:notify` | Show toasts/status in the host UI. |
| `tasks:create` / `tasks:read` | Create and read tasks (agent type only). |
| `channel:send` / `channel:send-direct` | Push messages out through installed channels. |
| `connections:<service>` | Use a named connection credential. |
| `a2a:delegate` | Delegate to an external A2A agent. |
| `audit:read` | Read the audit ledger (owner tier only). |

Full list: `packages/sdk/src/types/manifest.ts` (`CapabilityToken`).

---

## Activation contract

The `entry` module must default-export nothing and export an `activate`
function matching the SDK signature:

```ts
import type { PlexoSDK } from '@plexo/sdk'

export async function activate(sdk: PlexoSDK): Promise<void> {
    sdk.registerTool({
        name: 'my_tool',
        description: 'What it does, max 500 chars.',
        parameters: { type: 'object', properties: { /* ... */ }, required: [] },
        hints: { timeoutMs: 10_000, idempotent: true },
        handler: async (params, context) => {
            // params = validated input
            // context = { workspaceId, requestId, taskId? }
            return { ok: true }
        },
    })
}
```

Activation runs inside a Worker thread spawned by the persistent worker
pool (see `packages/agent/src/plugins/persistent-pool.ts`). The `sdk`
object is a host-bridged instance of `PlexoSDK`; host-side capabilities
(`storage`, `memory`, `connections`, `events`, etc.) are delegated back
to the API process via `postMessage`.

---

## Installing

From the CLI (once `plexo ext install` supports named registry installs):

```bash
plexo ext install @plexo/research-agent
```

From the marketplace at `/app/extensions`: click **Install**.

From the API directly:

```bash
curl -X POST $PUBLIC_URL/api/extensions \
    -H 'Content-Type: application/json' \
    -H "Cookie: $AUTH_COOKIE" \
    -d '{
        "workspaceId": "<uuid>",
        "manifest": <plexo.json contents>
    }'
```

After install, the row lives in the `extensions` table with
`enabled = false`. Enable it on `/app/agents` to spawn the worker.

---

## Validation

Run the validator programmatically:

```ts
import { validateManifest } from '@plexo/sdk'

const result = validateManifest(manifest, { hostComplianceLevel: 'full' })
if (!result.valid) {
    console.error(result.errors)
    process.exit(1)
}
```

Or validate a candidate file with tsx:

```bash
pnpm tsx extensions/core/research-agent/validate.mjs
```
