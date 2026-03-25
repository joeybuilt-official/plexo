# plexo.json — Extension Manifest Format

> Plexo Fabric Specification v0.4.0, §3

Every extension and agent requires a `plexo.json` manifest at its package root. The manifest declares identity, type, capabilities, trust, data residency, and escalation contracts.

## Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `plexo` | `string` | Fabric spec version (semver). Current: `"0.4.0"` |
| `name` | `string` | Scoped package name (`@scope/name`) |
| `version` | `string` | Extension version (semver) |
| `type` | `ManifestType` | One of: `skill`, `channel`, `tool`, `connector`, `agent` |
| `entry` | `string` | Relative path to entry point |
| `capabilities` | `CapabilityToken[]` | Required capability tokens |
| `displayName` | `string` | Human-readable name (max 50 chars) |
| `description` | `string` | Short description (max 280 chars) |
| `author` | `string` | Publisher name or organization |
| `license` | `string` | SPDX license identifier |

## Extension Types

| Type | Description |
|------|-------------|
| `skill` | Composite capability package — registers tools, schedules, widgets |
| `channel` | Messaging bridge (inbound/outbound) |
| `tool` | Stateless, single-purpose, called on demand |
| `connector` | Bridges an external MCP server |
| `agent` | Autonomous actor with a goal, planning loop, and identity (separate pillar) |

## Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `trust` | `TrustTier` | Trust tier: `owner`, `verified`, or `community` (§17) |
| `dataResidency` | `DataResidencyDeclaration` | External data destinations (§19) |
| `escalation` | `EscalationDeclaration` | Escalation contract for human oversight (§23) |
| `modelRequirements` | `ModelRequirements` | LLM model requirements for agent type (§24) |
| `did` | `string` | W3C Decentralized Identifier (§21) |
| `minHostLevel` | `HostComplianceLevel` | Minimum host compliance: `core`, `standard`, or `full` |
| `minFabricVersion` | `string` | Minimum Fabric spec version required |
| `resourceHints` | `ResourceHints` | Resource limits (maxMemoryMB, maxCpuShares, maxInvocationMs) |
| `peerExtensions` | `string[]` | Extensions this one works alongside |
| `behaviorRules` | `BehaviorRuleDefinition[]` | Agent behavior rules contributed by this extension |
| `prompts` | `PromptArtifact[]` | Prompt templates contributed by this extension (§7.6) |
| `contextDependencies` | `string[]` | Context dependencies required (§7.7) |

## Capability Tokens

Memory capabilities are entity-scoped at Standard and Full compliance hosts:

```
memory:read:<entity_type>    memory:write:<entity_type>
```

Entity types: `person`, `task`, `thread`, `note`, `transaction`, `calendar_event`, `file`.

Other tokens: `channel:send`, `schedule:register`, `tasks:create`, `events:publish`, `storage:read`, `storage:write`, `self:read`, `self:write`, `audit:read`, `identity:present`, `a2a:delegate`, `model:override`, `prompts:register`, `context:register`.

## Example

```json
{
  "plexo": "0.4.0",
  "name": "@acme/stripe-monitor",
  "version": "1.0.0",
  "type": "skill",
  "entry": "src/index.ts",
  "capabilities": [
    "storage:read",
    "storage:write",
    "connections:stripe",
    "memory:read:transaction",
    "memory:write:transaction",
    "schedule:register",
    "channel:send"
  ],
  "displayName": "Stripe Monitor",
  "description": "Monitor Stripe MRR and send daily reports.",
  "author": "Acme Inc",
  "license": "MIT",
  "trust": "verified"
}
```

## Type Source

The canonical TypeScript definition is `ExtensionManifest` in `packages/sdk/src/types/manifest.ts`.
