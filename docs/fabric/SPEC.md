# Plexo Fabric Specification v0.4.0

**Status:** Authoritative
**License:** AGPL-3.0-only
**Copyright:** (C) 2026 Joeybuilt LLC

---

## Table of Contents

- [1. Introduction & Core Architecture](#1-introduction--core-architecture)
- [2. Extension Types](#2-extension-types)
- [3. Manifest Schema](#3-manifest-schema)
- [4. Capability Tokens](#4-capability-tokens)
- [5. Isolation Contract](#5-isolation-contract)
- [6. Message Protocol](#6-message-protocol)
- [7. Host Subsystems](#7-host-subsystems)
  - [7.1 Tool Registry](#71-tool-registry)
  - [7.2 Task Router](#72-task-router)
  - [7.3 Channel Router](#73-channel-router)
  - [7.4 Event Bus](#74-event-bus)
  - [7.5 Memory Layer](#75-memory-layer)
  - [7.6 Prompt Library](#76-prompt-library)
  - [7.7 Context Layer](#77-context-layer)
- [8. Agent Contract](#8-agent-contract)
- [9. Lifecycle Hooks](#9-lifecycle-hooks)
- [10. Error Handling](#10-error-handling)
- [11. Versioning & Compatibility](#11-versioning--compatibility)
- [12. Registry Protocol](#12-registry-protocol)
- [13. Security Requirements](#13-security-requirements)
- [14. Compliance Levels](#14-compliance-levels)
- [16. Personal Entity Schema](#16-personal-entity-schema)
- [17. Trust Tiers](#17-trust-tiers)
- [18. Audit Trail](#18-audit-trail)
- [19. Data Residency](#19-data-residency)
- [20. UserSelf](#20-userselfpersistent-identity-graph)
- [21. DID + Verifiable Credentials](#21-did--verifiable-credentials)
- [22. A2A Bridge Layer](#22-a2a-bridge-layer)
- [23. Escalation Contract](#23-escalation-contract)
- [24. Model Context](#24-model-context)
- [25. Service Discovery](#25-service-discovery)
- [Appendix A: PlexoSDK Interface](#appendix-a-plexosdk-interface)
- [Appendix B: Interaction Matrix](#appendix-b-interaction-matrix)
- [Appendix C: Extension Type Quick Reference](#appendix-c-extension-type-quick-reference)

---

## 1. Introduction & Core Architecture

Plexo Fabric is a runtime specification for composable, sandboxed extensions and autonomous agents operating within a host application. It defines how extensions are declared, loaded, isolated, permissioned, and orchestrated.

### 1.1 Three Pillars

The architecture is organized around three distinct pillars:

**Connection** — An authenticated pipe to an external service. A Connection is inert on its own. It provides credentials (API key, OAuth2 token, webhook secret, basic auth) that extensions consume. A single Connection can serve many extensions. Connections are first-class objects managed by the host; extensions declare which connections they need via capability tokens (`connections:<service>`).

**Extension** — A capability package. An extension registers functions, schedules, widgets, prompts, and context blocks. It requires one or more Connections and does work when invoked. Extensions do not think, plan, or act autonomously. They execute in response to explicit invocations from the host, agents, or other extensions. Extension subtypes are: **skill**, **channel**, **tool**, and **connector**.

**Agent** — An autonomous actor with a goal, a planning loop, and an identity. An Agent orchestrates any number of Extensions to accomplish work. An Agent is NOT a subtype of Extension. It occupies its own pillar, shares the manifest format for packaging convenience, but implements a fundamentally different contract (shouldActivate, plan, executeStep, verifyStep, onEscalation). Agents are subject to the Escalation Contract (section 23) and human oversight requirements.

### 1.2 Agent Stacks

An Agent Stack is a pre-configured Agent + Extension bundle. Hosts SHOULD surface these as saveable, nameable presets. A stack manifest declares the agent, extensions, connections, and optional behavior overrides:

```json
{
  "plexo": "0.4.0",
  "name": "@acme/sales-agent-stack",
  "version": "1.0.0",
  "displayName": "Sales Agent Stack",
  "description": "Sales agent with CRM, email, and calendar extensions",
  "author": "Acme Corp",
  "license": "MIT",
  "agent": "@acme/sales-agent",
  "extensions": ["@acme/crm-skill", "@acme/email-channel", "@acme/calendar-tool"],
  "connections": ["salesforce", "gmail", "google-calendar"],
  "behaviorOverrides": {
    "max_emails_per_day": 50
  }
}
```

### 1.3 Protocol Stack

Plexo Fabric sits alongside and above existing interoperability protocols:

| Layer | Protocol | Relationship |
|-------|----------|-------------|
| Tool | MCP | Agent-to-tool. Connector type bridges MCP servers. |
| Agent | A2A | Agent-to-agent. Section 22 bridges A2A endpoints. |
| Fabric | Plexo | Defines how all the above is packaged, permissioned, isolated, and managed. |

### 1.4 Design Principles

1. **Isolation first.** Extensions run in sandboxed workers. No shared state except through host-mediated APIs.
2. **Explicit capabilities.** Every action requires a declared capability token. No implicit permissions.
3. **Human oversight.** Agents MUST escalate before irreversible actions. Standing approvals are user-owned.
4. **Portable identity.** Extensions and agents MAY carry W3C DIDs for cross-host identity.
5. **Auditable by default.** All extension actions are logged in an immutable audit trail at Standard and Full compliance.

---

## 2. Extension Types

Extensions are categorized by subtype. Each subtype is a filter badge in the host UI and determines which lifecycle hooks and manifest fields apply.

### 2.1 Type Definitions

| Type | Description | Primary Use | Min Host Level |
|------|-------------|-------------|----------------|
| `skill` | Composite capability package. Registers tools, schedules, widgets, prompts, and context. The general-purpose extension type. | CRM integrations, monitoring dashboards, automation workflows | Core |
| `channel` | Messaging bridge for inbound and outbound communication. Implements the Channel Contract (onActivate, onMessage, healthCheck, onDeactivate). | Email, Slack, SMS, webhook endpoints | Core |
| `tool` | Stateless, single-purpose function. Called on demand. No persistent state, no schedules, no widgets. Lightweight and composable. | Currency conversion, text summarization, data formatting | Core |
| `connector` | Bridges an external MCP server into the Plexo runtime. Translates MCP tool definitions into Plexo tool registrations. | Database access, file system access, third-party API servers | Core |
| `agent` | Autonomous actor with planning loop. Implements the Agent Contract (shouldActivate, plan, executeStep, verifyStep, onEscalation). Occupies its own architectural pillar. | Task automation, multi-step workflows, decision-making | Standard |

### 2.2 Type Properties

| Property | skill | channel | tool | connector | agent |
|----------|-------|---------|------|-----------|-------|
| Registers tools | Yes | No | Yes (single) | Yes (proxied) | No |
| Registers schedules | Yes | No | No | No | No |
| Registers widgets | Yes | No | No | No | No |
| Registers prompts | Yes | No | Yes | No | Yes |
| Registers context | Yes | No | Yes | No | Yes |
| Has persistent state | Yes | Yes | No | No | Yes |
| Implements Channel Contract | No | Yes | No | No | No |
| Implements Agent Contract | No | No | No | No | Yes |
| Subject to Escalation | No | No | No | No | Yes |
| Can create tasks | No | No | No | No | Yes |
| mcpServer manifest field | No | No | No | Required | No |
| channelConfig manifest field | No | Required | No | No | No |
| skillConfig manifest field | Optional | No | No | No | No |
| toolConfig manifest field | No | No | Optional | No | No |
| agentHints manifest field | No | No | No | No | Optional |

### 2.3 Legacy Type Mapping

Pre-0.4.0 manifests used different type names. Hosts MUST support these during migration:

| Legacy Type | Maps To |
|-------------|---------|
| `function` | `skill` |
| `mcp-server` | `connector` |

---

## 3. Manifest Schema

Every extension and agent is described by a `plexo.json` manifest file at the package root.

### 3.1 Required Fields

| Field | Type | Constraints |
|-------|------|-------------|
| `plexo` | `string` | Valid semver. Fabric spec version this manifest targets. |
| `name` | `string` | Scoped package name. Must match `@scope/name` format. |
| `version` | `string` | Valid semver. Extension version. |
| `type` | `ManifestType` | One of: `skill`, `channel`, `tool`, `connector`, `agent`. |
| `entry` | `string` | Relative path to entry point from package root. |
| `capabilities` | `CapabilityToken[]` | Array of capability tokens this extension requires. |
| `displayName` | `string` | Human-readable name. Max 50 characters. |
| `description` | `string` | Short description. Max 280 characters. |
| `author` | `string` | Publisher name or organization. |
| `license` | `string` | SPDX license identifier. |

### 3.2 Optional Fields

| Field | Type | Applies To | Description |
|-------|------|------------|-------------|
| `minHostLevel` | `HostComplianceLevel` | All | Minimum host compliance level required. |
| `minFabricVersion` | `string` | All | Minimum Fabric spec version required. |
| `homepage` | `string` | All | URL to extension homepage. |
| `repository` | `string` | All | URL to source repository. |
| `keywords` | `string[]` | All | Discovery keywords. |
| `icon` | `string` | All | Relative path to icon file. |
| `screenshots` | `string[]` | All | Relative paths to screenshot files. |
| `mcpServer` | `MCPServerConfig` | connector | MCP server transport configuration. |
| `agentHints` | `AgentHints` | agent | Task type hints and minimum confidence. |
| `channelConfig` | `JSONSchema` | channel | Configuration schema rendered as setup form. |
| `skillConfig` | `JSONSchema` | skill | Configuration schema rendered as settings form. |
| `toolConfig` | `JSONSchema` | tool | Configuration schema rendered as settings form. |
| `resourceHints` | `ResourceHints` | All | Memory, CPU, and invocation time hints. |
| `peerExtensions` | `string[]` | All | Extensions that should be co-installed. |
| `behaviorRules` | `BehaviorRuleDefinition[]` | agent | Configurable behavior rules. |
| `prompts` | `PromptArtifact[]` | All | Prompt templates contributed by this extension. |
| `contextDependencies` | `string[]` | All | Context block IDs this extension depends on. |
| `trust` | `TrustTier` | All | Trust tier declaration (section 17). |
| `dataResidency` | `DataResidencyDeclaration` | All | External data destination declaration (section 19). |
| `did` | `string` | All | W3C DID for cross-host identity (section 21). |
| `escalation` | `EscalationDeclaration` | agent | Escalation contract declaration (section 23). |
| `modelRequirements` | `ModelRequirements` | agent | LLM model requirements (section 24). |

### 3.3 MCPServerConfig

Required when `type` is `connector`:

```typescript
interface MCPServerConfig {
  transport: 'stdio' | 'sse'
  command?: string   // Required when transport is 'stdio'
  url?: string       // Required when transport is 'sse'
}
```

### 3.4 BehaviorRuleDefinition

Agent-type manifests MAY declare configurable behavior rules:

```typescript
interface BehaviorRuleDefinition {
  key: string
  label: string
  description: string
  type: 'safety_constraint' | 'operational_rule' | 'communication_style'
       | 'domain_knowledge' | 'persona_trait' | 'tool_preference' | 'quality_gate'
  defaultValue: {
    type: 'boolean' | 'string' | 'number' | 'enum' | 'text_block' | 'json'
    value: unknown
    options?: string[]
    min?: number
    max?: number
  }
  locked: boolean
}
```

When `locked` is `true`, the user cannot override the default value. Hosts MUST render unlocked rules as editable fields in the agent settings UI.

### 3.5 Validation Rules

1. `plexo` field MUST be valid semver and MUST NOT exceed the host's supported spec version.
2. `name` MUST match the regex `^@[a-z0-9-]+/[a-z0-9-]+$`.
3. `version` MUST be valid semver.
4. `type` MUST be one of the defined `ManifestType` values. Legacy values (`function`, `mcp-server`) MUST be accepted and mapped.
5. `entry` MUST point to an existing file relative to the package root.
6. `capabilities` MUST only contain valid `CapabilityToken` values. Unknown tokens MUST cause install rejection.
7. `displayName` MUST NOT exceed 50 characters.
8. `description` MUST NOT exceed 280 characters.
9. If `type` is `connector`, `mcpServer` MUST be present.
10. If `type` is `channel`, `channelConfig` SHOULD be present.
11. Entity-scoped memory tokens MUST use valid `EntityTypeName` values.
12. At Standard and Full compliance hosts, unscoped `memory:read` and `memory:write` tokens MUST be rejected. Entity-scoped tokens (`memory:read:<entity_type>`) are required.

### 3.6 Example Manifest

```json
{
  "plexo": "0.4.0",
  "name": "@acme/crm-skill",
  "version": "1.2.0",
  "type": "skill",
  "entry": "dist/index.js",
  "capabilities": [
    "memory:read:person",
    "memory:write:person",
    "memory:read:transaction",
    "connections:salesforce",
    "events:subscribe",
    "events:publish",
    "ui:notify",
    "prompts:register",
    "context:register"
  ],
  "displayName": "Acme CRM",
  "description": "Salesforce integration with contact sync, deal tracking, and activity logging.",
  "author": "Acme Corp",
  "license": "MIT",
  "minHostLevel": "standard",
  "trust": "verified",
  "dataResidency": {
    "sendsDataExternally": true,
    "externalDestinations": [
      { "host": "api.salesforce.com", "purpose": "CRM sync", "dataTypes": ["person", "transaction"] }
    ]
  },
  "prompts": [
    {
      "id": "deal-summary",
      "name": "Deal Summary",
      "description": "Summarize a Salesforce deal for review",
      "template": "Summarize the deal {{dealName}} for {{contactName}}, highlighting key terms and next steps.",
      "variables": [
        { "name": "dealName", "description": "Name of the deal", "type": "string" },
        { "name": "contactName", "description": "Primary contact name", "type": "string" }
      ],
      "tags": ["sales", "crm"],
      "version": "1.0.0",
      "priority": "normal"
    }
  ]
}
```

---

## 4. Capability Tokens

Every action an extension or agent can perform requires a declared capability token in its manifest. Hosts enforce these at runtime; any undeclared action is rejected with `CAPABILITY_DENIED`.

### 4.1 Token Categories

**Memory (entity-scoped)**

| Token | Description |
|-------|-------------|
| `memory:read:<entity_type>` | Read access to a specific entity type. Required at Standard and Full. |
| `memory:write:<entity_type>` | Write access to a specific entity type. Required at Standard and Full. |
| `memory:read:*` | Wildcard read access. Owner tier only. |
| `memory:write:*` | Wildcard write access. Owner tier only. |
| `memory:read` | DEPRECATED. Unscoped read. Invalid at Standard and Full compliance. |
| `memory:write` | DEPRECATED. Unscoped write. Invalid at Standard and Full compliance. |
| `memory:delete` | Delete memory entries. |

**Channel**

| Token | Description |
|-------|-------------|
| `channel:send` | Send messages through the channel router. |
| `channel:send-direct` | Send to a specific channel by ID. |
| `channel:receive` | Receive inbound messages from the channel router. |

**Scheduling**

| Token | Description |
|-------|-------------|
| `schedule:register` | Register cron-based scheduled jobs. |
| `schedule:manage` | List, pause, resume registered schedules. |

**UI**

| Token | Description |
|-------|-------------|
| `ui:register-widget` | Register dashboard widgets. |
| `ui:notify` | Send user-visible notifications. |

**Tasks**

| Token | Description |
|-------|-------------|
| `tasks:create` | Create new tasks. Agent type only. |
| `tasks:read` | Read a specific task by ID. |
| `tasks:read-all` | List all tasks matching a filter. |

**Events**

| Token | Description |
|-------|-------------|
| `events:subscribe` | Subscribe to event bus topics. |
| `events:publish` | Publish to extension-scoped topics (`ext.<scope>.*`). |

**Storage**

| Token | Description |
|-------|-------------|
| `storage:read` | Read from key-value storage. |
| `storage:write` | Write to and delete from key-value storage. |

**Prompts (section 7.6)**

| Token | Description |
|-------|-------------|
| `prompts:register` | Register prompt templates during activation. |
| `prompts:read` | List and resolve prompt templates from other extensions. |

**Context (section 7.7)**

| Token | Description |
|-------|-------------|
| `context:register` | Register context blocks during activation. |
| `context:write` | Update content for registered context blocks at runtime. |
| `context:read` | List context blocks from other extensions. |

**Connections**

| Token | Description |
|-------|-------------|
| `connections:<service>` | Access credentials for a named external service. |

**UserSelf (section 20)**

| Token | Description |
|-------|-------------|
| `self:read` | Read from the persistent UserSelf graph with field-level scoping. |
| `self:write` | Propose updates to the UserSelf graph via structured proposals. |

**Audit (section 18)**

| Token | Description |
|-------|-------------|
| `audit:read` | Query the immutable audit ledger. Owner tier only. |

**Identity (section 21)**

| Token | Description |
|-------|-------------|
| `identity:present` | Present DID and verifiable credentials for cross-host interactions. |

**A2A (section 22)**

| Token | Description |
|-------|-------------|
| `a2a:delegate` | Delegate tasks to external A2A agents. Logged in audit trail. |

**Model (section 24)**

| Token | Description |
|-------|-------------|
| `model:override` | Dynamically select LLM model at runtime. Agent type only. |

**Entity (section 16)**

| Token | Description |
|-------|-------------|
| `entity:create:<entity_type>` | Create entities of a specific type. |
| `entity:modify:<entity_type>` | Modify entities of a specific type. |
| `entity:delete:<entity_type>` | Delete entities of a specific type. |

**Host-scoped**

| Token | Description |
|-------|-------------|
| `host:<vendor>:<capability>` | Vendor-specific host capabilities. Not portable. |

### 4.2 Entity-Scoped Memory Rules

At Standard and Full compliance hosts:

1. Unscoped `memory:read` and `memory:write` are invalid and MUST be rejected at install time with error code `SCOPED_MEMORY_REQUIRED`.
2. Extensions MUST declare the specific entity types they access: `memory:read:person`, `memory:write:task`, etc.
3. Wildcard tokens (`memory:read:*`, `memory:write:*`) are restricted to owner trust tier.
4. At Core compliance hosts, unscoped tokens remain valid for backward compatibility.

### 4.3 Validation

Hosts MUST validate capability tokens at install time. Any token that does not match the defined grammar MUST cause install rejection. Hosts MUST NOT silently ignore unknown tokens, as this masks misconfiguration.

---

## 5. Isolation Contract

### 5.1 Isolation Mechanisms

All extensions execute in isolated sandboxes. The host MUST enforce the following isolation guarantees:

1. **Process isolation.** Each extension runs in its own worker process (or equivalent sandbox). Extensions cannot access each other's memory space, file system, or network connections directly.
2. **Capability enforcement.** The host intercepts all SDK calls and validates the calling extension has the required capability token. Calls without matching tokens are rejected with `CAPABILITY_DENIED`.
3. **Network isolation.** Extensions with `dataResidency.sendsDataExternally: false` MUST NOT be permitted to make outbound HTTP requests. Hosts at Full compliance MUST enforce network-level restrictions, not just SDK-level checks.
4. **Storage isolation.** Each extension's key-value storage, memory entries, and registered artifacts (tools, prompts, context blocks) are namespaced to that extension. No cross-extension access except through host-mediated APIs.

### 5.2 Resource Limits

Extensions MAY declare resource hints in their manifest:

```typescript
interface ResourceHints {
  maxMemoryMB?: number
  maxCpuShares?: number
  maxInvocationMs?: number
}
```

Hosts SHOULD enforce these limits. If an extension exceeds declared limits:

- Memory: Host terminates the worker and emits `extension.crashed`.
- CPU: Host throttles execution.
- Invocation time: Host aborts the invocation and returns `TIMEOUT`.

Default limits when no hints are declared:

| Resource | Default Limit |
|----------|--------------|
| Memory | 256 MB |
| CPU shares | 100 (relative) |
| Invocation timeout | 30,000 ms |

### 5.3 Worker Lifecycle

1. **Load.** Host reads `plexo.json`, validates manifest, checks capability tokens against trust tier ceilings.
2. **Spawn.** Host creates an isolated worker, injects the `PlexoSDK` instance.
3. **Activate.** Host calls the extension's `activate(sdk)` function. All registration calls (registerTool, registerSchedule, registerWidget, registerPrompt, registerContext) are valid only during this phase.
4. **Run.** Extension responds to invocations, events, and lifecycle hooks.
5. **Deactivate.** Host calls `deactivate()`. Extension cleans up resources.
6. **Terminate.** Host destroys the worker.

Registration calls made after activation completes are no-ops with a logged warning.

### 5.4 Crash Recovery

When an extension worker crashes:

1. Host emits `extension.crashed` event with the extension name and error.
2. Host logs the crash in the audit trail.
3. Host MAY attempt to restart the worker up to 3 times with exponential backoff (1s, 5s, 25s).
4. After 3 failed restarts, the extension is marked as disabled.
5. If the extension is a channel, the Channel Router triggers failover (section 7.3).

---

## 6. Message Protocol

### 6.1 Envelope

All messages between host and extensions use the `FabricMessage` envelope:

```typescript
interface FabricMessage {
  plexo: '0.4.0'
  id: string           // Unique message ID (UUID v4)
  type: MessageType
  timestamp: string    // ISO 8601
  payload: unknown
}
```

### 6.2 Message Types

| Type | Direction | Description |
|------|-----------|-------------|
| `invoke` | Host -> Extension | Invoke a registered tool. |
| `invoke_result` | Extension -> Host | Return tool invocation result. |
| `event` | Bidirectional | Event bus message. |
| `channel_message` | Host -> Extension | Deliver inbound channel message. |
| `channel_send` | Extension -> Host | Extension sends outbound message. |
| `channel_health_check` | Host -> Extension | Request channel health status. |
| `channel_health_result` | Extension -> Host | Channel health response. |
| `activate` | Host -> Extension | Trigger extension activation. |
| `deactivate` | Host -> Extension | Trigger extension deactivation. |
| `error` | Bidirectional | Error notification. |
| `escalation_request` | Extension -> Host | Agent requests human approval. |
| `escalation_response` | Host -> Extension | Host relays user decision. |
| `entity_resolve` | Extension -> Host | Entity resolution request. |
| `entity_resolve_result` | Host -> Extension | Entity resolution response. |
| `a2a_inbound` | Host -> Extension | Inbound A2A task. |
| `a2a_outbound` | Extension -> Host | Outbound A2A delegation. |
| `self_read` | Extension -> Host | UserSelf read request. |
| `self_propose` | Extension -> Host | UserSelf proposal. |
| `audit_query` | Extension -> Host | Audit trail query. |

### 6.3 Error Codes

```typescript
type ErrorCode =
  | 'CAPABILITY_DENIED'
  | 'TOOL_NOT_FOUND'
  | 'TIMEOUT'
  | 'INTERNAL_ERROR'
  | 'INVALID_PARAMS'
  | 'COMPLIANCE_INSUFFICIENT'
  | 'NOT_IMPLEMENTED'
  | 'EXTENSION_CRASHED'
  | 'TRUST_TIER_EXCEEDED'
  | 'DATA_RESIDENCY_VIOLATION'
  | 'ESCALATION_DENIED'
  | 'ESCALATION_TIMEOUT'
  | 'ENTITY_NOT_FOUND'
  | 'DID_VERIFICATION_FAILED'
  | 'MODEL_REQUIREMENTS_UNMET'
  | 'SCOPED_MEMORY_REQUIRED'
```

### 6.4 FabricError

```typescript
interface FabricError {
  code: ErrorCode
  message: string
  detail?: string      // Original error detail, stripped in production
  retryable: boolean
}
```

### 6.5 Request/Response Semantics

- Every `invoke` message MUST receive exactly one `invoke_result` or `error` response.
- The `id` of the response MUST reference the `id` of the originating request.
- Hosts MUST enforce invocation timeouts. If an extension does not respond within `timeoutMs` (default 30,000 ms), the host sends an `error` with code `TIMEOUT`.
- Extensions MUST NOT send unsolicited `invoke_result` messages.
- Event messages are fire-and-forget; no response is expected.

### 6.6 Message Priority

Channel messages carry a priority field:

| Priority | Description |
|----------|-------------|
| `normal` | Standard delivery. No SLA. |
| `high` | Prioritized in the channel router queue. |
| `urgent` | Immediate delivery attempt. Host MAY bypass batching. |

---

## 7. Host Subsystems

### 7.1 Tool Registry

The Tool Registry is the host's catalog of all callable tools. Extensions register tools during activation; agents and the host discover and invoke them at runtime.

#### 7.1.1 Registration

Extensions register tools via `sdk.registerTool()` during activation:

```typescript
interface ToolRegistration {
  name: string                // Alphanumeric and underscores. Unique within the extension.
  description: string         // Max 500 characters. Shown to agents.
  parameters: JSONSchema      // Must be type "object" at top level.
  hints?: {
    estimatedMs?: number
    timeoutMs?: number        // Hard timeout. Defaults to 30,000.
    hasSideEffects?: boolean
    idempotent?: boolean
  }
  handler(params: unknown, context: InvokeContext): Promise<unknown>
}
```

#### 7.1.2 Collision Handling

Tool names are globally unique within a workspace, qualified by extension name: `@scope/extension-name.tool_name`. If two extensions register tools with the same unqualified name:

1. Host MUST retain both, qualified by extension name.
2. Agents MUST use the fully qualified name when ambiguity exists.
3. Host UI SHOULD surface the collision as a warning.

#### 7.1.3 Invocation

1. Agent or host resolves tool name to a registered handler.
2. Host validates that the invoking extension/agent has the necessary capability.
3. Host creates an `InvokeContext` with workspace ID, optional task ID, and a unique request ID.
4. Host sends an `invoke` message to the owning extension's worker.
5. Extension handler executes and returns the result.
6. Host receives `invoke_result` and delivers to the caller.
7. Host logs the invocation in the audit trail.

#### 7.1.4 Tool Summary

Extensions can discover tools registered by other extensions via the Tool Registry:

```typescript
interface ToolSummary {
  name: string
  description: string
  ownerExtension: string
}
```

---

### 7.2 Task Router

The Task Router dispatches incoming tasks to the most capable agent.

#### 7.2.1 Routing Algorithm

1. Host receives a new task (user-initiated or extension-created).
2. Host broadcasts the task description to all active agents via `shouldActivate()`.
3. Each agent returns `{ activate: boolean, confidence: number, reasoning?: string }`.
4. Host selects the agent with the highest confidence among those returning `activate: true`.
5. If no agent claims the task, the host handles it directly or notifies the user.
6. If multiple agents tie, the host uses installation order as a tiebreaker.

#### 7.2.2 Task States

| State | Description |
|-------|-------------|
| `pending` | Task created, not yet claimed. |
| `claimed` | Agent has accepted the task. |
| `planning` | Agent is generating a plan. |
| `executing` | Agent is executing plan steps. |
| `blocked` | Task is waiting on escalation, missing capability, or external dependency. |
| `completed` | All steps succeeded. |
| `failed` | Task failed and agent exhausted retries. |
| `cancelled` | User or system cancelled the task. |

#### 7.2.3 Task Schema

```typescript
interface TaskCreateOptions {
  title: string
  type: string
  context?: unknown
}

interface TaskFilter {
  status?: string
  type?: string
}
```

Tasks are created via `sdk.tasks.create()` (requires `tasks:create`, agent type only) or by the host directly.

---

### 7.3 Channel Router

The Channel Router manages inbound and outbound message flow across channel extensions.

#### 7.3.1 Routing Policy

- **Inbound**: When a channel extension receives an external message, it calls `sdk.channel.send()`. The host routes the message to the appropriate agent or handler based on task context and channel configuration.
- **Outbound**: When an agent or extension calls `sdk.channel.sendDirect(channelId, message)`, the host delivers the message to the specified channel extension for external dispatch.
- **Failover**: If a channel's `healthCheck()` returns `healthy: false`, the host SHOULD route to an alternative channel of the same type, if available.

#### 7.3.2 Health Checks

The host periodically calls `healthCheck()` on all active channel extensions:

```typescript
interface ChannelHealthResult {
  healthy: boolean
  latencyMs?: number
  error?: string
}
```

Health check interval is host-configurable. Recommended default: 60 seconds.

#### 7.3.3 Channel Pairing

A channel extension MUST implement all four lifecycle methods:

| Method | When Called | Purpose |
|--------|------------|---------|
| `onActivate()` | Activation | Start listening for inbound messages. |
| `onMessage(message)` | Outbound dispatch | Send a message via this channel. |
| `healthCheck()` | Periodic | Report channel health. |
| `onDeactivate()` | Deactivation | Stop listeners, clean up. |

---

### 7.4 Event Bus

The Event Bus provides publish/subscribe messaging between the host, extensions, and agents.

#### 7.4.1 Topic Namespaces

| Namespace | Publisher | Description |
|-----------|-----------|-------------|
| `task.*` | Host | Task lifecycle events. |
| `channel.*` | Host | Channel message and health events. |
| `extension.*` | Host | Extension lifecycle events. |
| `connection.*` | Host | Connection lifecycle events. |
| `memory.*` | Host | Memory write events. |
| `entity.*` | Host | Entity lifecycle events (section 16). |
| `escalation.*` | Host | Escalation lifecycle events (section 23). |
| `audit.*` | Host | Audit entry events (section 18, owner tier only). |
| `self.*` | Host | UserSelf update events (section 20). |
| `agent.*` | Host | Agent lifecycle events. |
| `a2a.*` | Host | A2A bridge events (section 22). |
| `prompt.*` | Host | Prompt library events (section 7.6). |
| `context.*` | Host | Context layer events (section 7.7). |
| `ext.<scope>.*` | Extensions | Extension-scoped custom events. |

Extensions MUST only publish to the `ext.<scope>.*` namespace. Attempts to publish to host-owned namespaces MUST be rejected with `CAPABILITY_DENIED`.

#### 7.4.2 Standard Topics

| Topic | Payload Type | Description |
|-------|-------------|-------------|
| `task.created` | `TaskCreatedPayload` | New task created. |
| `task.completed` | `TaskCompletedPayload` | Task finished successfully. |
| `task.failed` | `TaskFailedPayload` | Task failed. |
| `task.blocked` | `TaskBlockedPayload` | Task waiting on dependency. |
| `channel.message.received` | `ChannelMessageReceivedPayload` | Inbound channel message. |
| `channel.health.changed` | `ChannelHealthChangedPayload` | Channel health status change. |
| `extension.activated` | `ExtensionActivatedPayload` | Extension activated. |
| `extension.deactivated` | `ExtensionDeactivatedPayload` | Extension deactivated. |
| `extension.crashed` | `ExtensionCrashedPayload` | Extension worker crashed. |
| `connection.added` | `ConnectionAddedPayload` | New connection established. |
| `connection.removed` | `ConnectionRemovedPayload` | Connection removed. |
| `memory.written` | `MemoryWrittenPayload` | Memory entry written. |
| `entity.created` | `EntityCreatedPayload` | Entity created. |
| `entity.modified` | `EntityModifiedPayload` | Entity modified. |
| `entity.deleted` | `EntityDeletedPayload` | Entity deleted. |
| `entity.linked` | `EntityLinkedPayload` | Entities linked. |
| `escalation.triggered` | `EscalationTriggeredPayload` | Escalation requested. |
| `escalation.resolved` | `EscalationResolvedPayload` | Escalation resolved. |
| `escalation.timed_out` | `EscalationTimedOutPayload` | Escalation timed out. |
| `audit.entry.created` | `AuditEntryCreatedPayload` | Audit entry logged. |
| `self.updated` | `SelfUpdatedPayload` | UserSelf field updated. |
| `self.proposal.received` | `SelfProposalReceivedPayload` | UserSelf proposal received. |
| `agent.activated` | `AgentActivatedPayload` | Agent activated. |
| `agent.deactivated` | `AgentDeactivatedPayload` | Agent deactivated. |
| `agent.plan.created` | `AgentPlanCreatedPayload` | Agent created a plan. |
| `agent.step.completed` | `AgentStepCompletedPayload` | Agent step succeeded. |
| `agent.step.failed` | `AgentStepFailedPayload` | Agent step failed. |
| `a2a.inbound.received` | `A2AInboundReceivedPayload` | Inbound A2A task received. |
| `a2a.delegation.sent` | `A2ADelegationSentPayload` | Outbound A2A delegation sent. |
| `a2a.delegation.completed` | `A2ADelegationCompletedPayload` | A2A delegation completed. |
| `prompt.registered` | `PromptRegisteredPayload` | Prompt template registered. |
| `prompt.enabled` | `PromptEnabledPayload` | Prompt template enabled. |
| `context.registered` | `ContextRegisteredPayload` | Context block registered. |
| `context.updated` | `ContextUpdatedPayload` | Context block content updated. |
| `context.expired` | `ContextExpiredPayload` | Context block TTL expired. |

#### 7.4.3 Delivery Guarantees

- **At-most-once.** Event delivery is best-effort. Hosts are not required to implement persistent event queues.
- **Ordering.** Events within a single topic are delivered in order. Cross-topic ordering is not guaranteed.
- **Backpressure.** If a subscriber's handler is slow, the host MAY drop events for that subscriber after a configurable queue depth (default: 100 events).

#### 7.4.4 Custom Topics

Extensions publish custom events via `sdk.events.publish()`:

```typescript
customTopic('acme', 'stripe-monitor', 'mrr.updated')
// => 'ext.acme.stripe-monitor.mrr.updated'
```

The `ext.` prefix is enforced. Extensions cannot publish to topics outside their scope.

---

### 7.5 Memory Layer

The Memory Layer provides persistent, tagged, searchable memory entries scoped to entity types.

#### 7.5.1 Entry Schema

```typescript
interface MemoryEntry {
  id: string
  content: string
  tags?: string[]
  authorExtension: ExtensionName | 'host'
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
  ttl?: number
  entityType?: EntityTypeName    // Section 16
  entityId?: string              // Section 16
}
```

#### 7.5.2 Scoping

At Standard and Full compliance:

- Memory entries MUST be associated with an entity type.
- Capability tokens MUST be entity-scoped: `memory:read:person`, `memory:write:task`, etc.
- Extensions can only read/write entries matching their declared entity types.
- Host-written entries (`authorExtension: 'host'`) are accessible to any extension with the matching entity type token.

At Core compliance:

- Unscoped `memory:read` / `memory:write` tokens are accepted for backward compatibility.
- Entity-type association is optional.

#### 7.5.3 API

```typescript
sdk.memory.read(query, options?)   // Requires memory:read or memory:read:<entity_type>
sdk.memory.write(entry)            // Requires memory:write or memory:write:<entity_type>
sdk.memory.delete(id)              // Requires memory:delete
```

Read accepts a text query string and optional filters:

```typescript
{
  tags?: string[]
  limit?: number
  entityType?: EntityTypeName
}
```

Write accepts:

```typescript
{
  content: string
  tags?: string[]
  metadata?: Record<string, unknown>
  ttl?: number
  entityType?: EntityTypeName
  entityId?: string
}
```

Hosts MUST implement semantic or full-text search for memory queries. Exact implementation is host-defined.

---

### 7.6 Prompt Library

The Prompt Library enables extensions to contribute versioned, discoverable prompt templates that are resolved across extensions and injected into LLM interactions at runtime.

#### 7.6.1 Prompt Artifact Schema

Prompt templates are declared in the manifest's `prompts` array or registered at runtime via `sdk.registerPrompt()`:

```typescript
interface PromptArtifact {
  id: string                // Unique within the extension
  name: string              // Max 100 chars
  description: string       // Max 500 chars
  template: string          // Template text with {{variable}} placeholders
  variables?: PromptVariable[]
  tags?: string[]           // Max 10, for discovery
  version: string           // Semver, independent of extension version
  priority?: 'low' | 'normal' | 'high' | 'critical'
  dependencies?: string[]   // Format: "context:<name>:<id>"
}

interface PromptVariable {
  name: string
  description: string
  type: 'string' | 'number' | 'boolean' | 'enum'
  required?: boolean        // Default: true
  default?: string | number | boolean
  enum?: string[]
}
```

#### 7.6.2 Variable Interpolation

1. Templates use `{{variableName}}` syntax for variable placeholders.
2. When `sdk.prompts.resolve(promptId, variables)` is called, the host substitutes each `{{variableName}}` with the corresponding value from the `variables` map.
3. Required variables without defaults that are not supplied MUST cause a resolution error.
4. Unknown variables in the template (not declared in the `variables` array) MUST be left as-is.
5. Variable values are string-coerced before substitution. Enum variables MUST be validated against the declared `enum` array.

#### 7.6.3 Host Responsibilities

1. **Registration.** Accept `registerPrompt()` calls during activation. Reject calls after activation with a warning.
2. **Storage.** Persist prompt registrations across sessions.
3. **Discovery.** Implement `sdk.prompts.list()` with optional tag filtering.
4. **Resolution.** Implement `sdk.prompts.resolve()` with full variable interpolation.
5. **Dependency resolution.** If a prompt declares `dependencies`, the host MUST verify the referenced context blocks are active before allowing resolution.
6. **Events.** Emit `prompt.registered` and `prompt.enabled` events.
7. **User control.** Hosts SHOULD provide UI for users to enable/disable individual prompts.

#### 7.6.4 Versioning

Prompt templates carry their own semver version independent of the extension version. When an extension is updated and a prompt's version changes:

1. Host SHOULD preserve the previous version for rollback.
2. Host MUST emit `prompt.registered` with the new version.
3. If the prompt's `priority` changed, host MUST re-evaluate injection order.

#### 7.6.5 SDK Methods

```typescript
// Registration (during activate() only)
sdk.registerPrompt(prompt: PromptRegistration): void   // Requires prompts:register

// Runtime
sdk.prompts.list(options?: { tags?: string[] }): Promise<PromptSummary[]>  // Requires prompts:read
sdk.prompts.resolve(promptId: string, variables?: Record<string, unknown>): Promise<string>  // Requires prompts:read
```

---

### 7.7 Context Layer

The Context Layer is a push-based mechanism for extensions to contribute structured, prioritized context blocks that are injected into LLM system prompts at execution time.

#### 7.7.1 Context Artifact Schema

```typescript
interface ContextArtifact {
  id: string                // Unique within the extension
  name: string              // Max 100 chars
  description: string       // Max 500 chars
  content: string           // Static text or {{variable}} template
  contentType?: string      // MIME type; default: "text/plain"
  priority: 'low' | 'normal' | 'high' | 'critical'
  ttl?: number              // Seconds; undefined = no expiry
  tags?: string[]           // Max 10, for discovery
  estimatedTokens?: number  // For budget allocation
}
```

#### 7.7.2 Injection Protocol

1. At LLM execution time, the host collects all active context blocks.
2. Blocks are sorted by priority: `critical` > `high` > `normal` > `low`.
3. Within the same priority level, blocks are ordered by registration time (first registered = first injected).
4. The host assembles the system prompt by concatenating context blocks in order.
5. If token budget is exhausted, lower-priority blocks are truncated or omitted.

#### 7.7.3 Priority Model

| Priority | Behavior |
|----------|----------|
| `critical` | Always injected. Never truncated. Overcounting against budget causes lower blocks to be dropped. |
| `high` | Injected before normal/low. Truncated only if critical blocks consume the entire budget. |
| `normal` | Standard injection. Truncated if budget is tight. |
| `low` | Injected last. First to be dropped when budget is exceeded. |

#### 7.7.4 TTL and Expiry

- Context blocks with a `ttl` field expire after the specified number of seconds.
- Expired blocks are automatically removed and a `context.expired` event is emitted.
- Extensions can update a block's content (and reset TTL) via `sdk.context.update()`.
- Blocks without TTL persist until the extension is deactivated or the block is explicitly removed.

#### 7.7.5 Rate Limiting

Hosts MUST enforce rate limits on context updates to prevent abuse:

- Maximum context blocks per extension: 10 (host-configurable).
- Maximum `sdk.context.update()` calls per minute per extension: 60 (host-configurable).
- Maximum total content size across all blocks per extension: 50,000 characters (host-configurable).

Exceeding rate limits MUST return an error, not silently drop updates.

#### 7.7.6 Token Budgeting

If the host supports token budgeting (`host.capabilities.tokenBudgeting === true`):

1. Each context block's `estimatedTokens` field informs the budget allocator.
2. The host maintains a total token budget for system prompt context (host-configurable).
3. Blocks are allocated budget in priority order until the budget is exhausted.
4. Extensions can query remaining budget via `sdk.context.list()` (each entry includes `estimatedTokens`).

#### 7.7.7 SDK Methods

```typescript
// Registration (during activate() only)
sdk.registerContext(context: ContextRegistration): void   // Requires context:register

// Runtime
sdk.context.update(contextId: string, content: string, options?: {
  ttl?: number
  estimatedTokens?: number
}): Promise<void>                                         // Requires context:write

sdk.context.list(): Promise<ContextSummary[]>             // Requires context:read
```

---

## 8. Agent Contract

An Agent is an autonomous actor that implements the Agent Contract interface. Agents plan, execute, verify, and escalate.

### 8.1 Required Interface

```typescript
interface AgentExtension {
  shouldActivate(task: { title: string; type: string; context?: unknown }): Promise<ShouldActivateResult>
  plan(task: { title: string; type: string; context?: unknown }): Promise<Plan>
  executeStep(step: PlanStep, context: { workspaceId: string; taskId: string }): Promise<StepResult>
  verifyStep(result: StepResult): Promise<{ ok: boolean; reason?: string }>
  onEscalation(reason: EscalationReason, context: unknown): Promise<EscalationResponse>
}
```

### 8.2 Plan Schema

```typescript
interface Plan {
  steps: PlanStep[]
  estimatedSeconds?: number
  confidence: number          // 0-1
}

interface PlanStep {
  id: string
  description: string
  toolCall?: ToolCall
  oneWayDoor?: OneWayDoor
  dependsOn?: string[]
  escalationTrigger?: EscalationTrigger
}

interface ToolCall {
  tool: string
  params: Record<string, unknown>
}
```

### 8.3 Step Result

```typescript
interface StepResult {
  stepId: string
  ok: boolean
  output?: unknown
  error?: string
  durationMs: number
}
```

### 8.4 One-Way Door Protocol

A one-way door is an action that cannot be undone. Agents MUST mark plan steps as one-way doors when they involve:

| Type | Description |
|------|-------------|
| `irreversible_action` | General irreversible action. |
| `external_write` | Writing data to an external system. |
| `financial_transaction` | Moving money or committing financial obligations. |
| `data_deletion` | Permanent data removal. |
| `permission_escalation` | Changing access permissions. |

When the host encounters a step with `oneWayDoor` set:

1. Host pauses execution.
2. Host notifies the user with the step description, action, and consequence.
3. User approves or denies.
4. If approved, host proceeds. If denied, host marks the step as failed with reason "user_denied".

### 8.5 Escalation Integration

Agents MUST implement `onEscalation()`. This method is called when:

- A plan step has an `escalationTrigger` set.
- The agent calls `sdk.escalate()` directly.
- The host detects a trigger condition (section 23).

The agent MUST pause and wait for the host to relay the user's response.

### 8.6 Quality Scoring

After task completion, hosts SHOULD compute a quality score:

1. Ratio of successful steps to total steps.
2. Time taken vs. estimated time.
3. Number of escalations required.
4. Number of retries.

Hosts SHOULD surface this score in the admin UI and log it in the audit trail.

---

## 9. Lifecycle Hooks

### 9.1 Common Hooks (All Extension Types)

| Hook | Signature | When Called |
|------|-----------|------------|
| `activate(sdk: PlexoSDK)` | `(sdk) => Promise<void>` | Worker spawned. Register tools, schedules, widgets, prompts, context. |
| `deactivate()` | `() => Promise<void>` | Worker shutting down. Clean up resources. |

### 9.2 Channel-Specific Hooks

| Hook | Signature | When Called |
|------|-----------|------------|
| `onActivate()` | `() => Promise<void>` | After `activate()`. Start listening for inbound messages. |
| `onMessage(message)` | `(InboundMessage) => Promise<void>` | Host wants to send outbound via this channel. |
| `healthCheck()` | `() => Promise<ChannelHealthResult>` | Periodic health probe from Channel Router. |
| `onDeactivate()` | `() => Promise<void>` | Before `deactivate()`. Stop listeners. |

### 9.3 Agent-Specific Hooks

| Hook | Signature | When Called |
|------|-----------|------------|
| `shouldActivate(task)` | `(task) => Promise<ShouldActivateResult>` | New task available. Agent bids on it. |
| `plan(task)` | `(task) => Promise<Plan>` | Agent won the routing competition. |
| `executeStep(step, context)` | `(step, ctx) => Promise<StepResult>` | Host executor runs each step. |
| `verifyStep(result)` | `(result) => Promise<{ ok, reason? }>` | After each step. Continue or escalate. |
| `onEscalation(reason, context)` | `(reason, ctx) => Promise<EscalationResponse>` | Escalation required. |

### 9.4 Execution Guarantees

1. `activate()` is called exactly once per worker lifecycle.
2. `deactivate()` is called at most once. If the worker crashes, `deactivate()` may not be called.
3. Registration calls (registerTool, registerPrompt, etc.) are valid ONLY during `activate()`.
4. Channel hooks are called in order: `onActivate` -> (`onMessage` | `healthCheck`)* -> `onDeactivate`.
5. Agent hooks follow the sequence: `shouldActivate` -> `plan` -> (`executeStep` -> `verifyStep`)* -> completion/failure.
6. All hooks MUST complete within the configured timeout (default: 30,000 ms for invocation hooks, 60,000 ms for activation).

---

## 10. Error Handling

### 10.1 Extension Responsibilities

1. Extensions MUST catch their own errors and return structured error results rather than throwing uncaught exceptions.
2. Tool handlers MUST return error information in the result payload rather than rejecting the promise, when the error is domain-specific (e.g., "record not found").
3. Uncaught exceptions in extension code MUST be caught by the host worker sandbox and translated to `EXTENSION_CRASHED` errors.
4. Extensions MUST NOT retry failed operations unless they have declared `idempotent: true` on the tool.

### 10.2 Host Responsibilities

1. The host MUST catch all errors from extension workers and wrap them in `FabricError` envelopes.
2. The host MUST strip `detail` fields in production environments to prevent information leakage.
3. The host MUST log all errors in the audit trail (Standard and Full compliance).
4. The host MUST return appropriate error codes; generic `INTERNAL_ERROR` should be used only when no specific code applies.

### 10.3 Retry Policy

| Error Code | Retryable | Default Retry Strategy |
|------------|-----------|----------------------|
| `CAPABILITY_DENIED` | No | Fail immediately. Manifest misconfiguration. |
| `TOOL_NOT_FOUND` | No | Fail immediately. Tool not registered. |
| `TIMEOUT` | Yes | Retry up to 2 times with exponential backoff (1s, 5s). |
| `INTERNAL_ERROR` | Yes | Retry up to 1 time after 2s delay. |
| `INVALID_PARAMS` | No | Fail immediately. Caller must fix parameters. |
| `COMPLIANCE_INSUFFICIENT` | No | Fail immediately. Host does not meet extension requirements. |
| `NOT_IMPLEMENTED` | No | Fail immediately. Feature not available. |
| `EXTENSION_CRASHED` | Yes | Host auto-restarts worker up to 3 times (1s, 5s, 25s). |
| `TRUST_TIER_EXCEEDED` | No | Fail immediately. Trust tier does not permit this capability. |
| `DATA_RESIDENCY_VIOLATION` | No | Fail immediately. Unauthorized external data transfer. |
| `ESCALATION_DENIED` | No | User denied the escalation. Agent must abort or replan. |
| `ESCALATION_TIMEOUT` | No | No user response. Action denied and logged. |
| `ENTITY_NOT_FOUND` | No | Fail immediately. Entity does not exist. |
| `DID_VERIFICATION_FAILED` | No | Fail immediately. DID or VC invalid/expired. |
| `MODEL_REQUIREMENTS_UNMET` | No | Fail immediately. Host cannot satisfy model requirements. |
| `SCOPED_MEMORY_REQUIRED` | No | Fail immediately. Unscoped memory token at Standard+ host. |

---

## 11. Versioning & Compatibility

### 11.1 Spec Versioning

The Plexo Fabric Specification uses semantic versioning:

- **Major** (X.0.0): Breaking changes. Extensions targeting a previous major version are incompatible.
- **Minor** (0.X.0): New features, backward-compatible. Extensions targeting a lower minor version continue to work.
- **Patch** (0.0.X): Bug fixes and clarifications. No behavioral changes.

The current spec version is **0.4.0**.

### 11.2 Extension Compatibility

Extensions declare the target spec version in the `plexo` field of their manifest. Hosts determine compatibility:

1. If `extension.plexo.major !== host.fabricVersion.major` and major > 0, the extension is incompatible. Reject at install.
2. If `extension.plexo.minor > host.fabricVersion.minor`, the extension requires features the host does not support. Reject at install.
3. If `extension.plexo.minor <= host.fabricVersion.minor`, the extension is compatible.
4. If `extension.minFabricVersion` is set and exceeds the host version, reject at install.

### 11.3 Host Version Advertisement

The host exposes its capabilities via the `PlexoSDK.host` object:

```typescript
interface HostInfo {
  fabricVersion: string
  complianceLevel: HostComplianceLevel
  name: string
  version: string
  capabilities?: {
    prompts?: boolean
    context?: boolean
    tokenBudgeting?: boolean
  }
}
```

Extensions can check `sdk.host.fabricVersion` and `sdk.host.complianceLevel` at activation to adjust behavior.

### 11.4 Feature Capability Advertisement

Hosts SHOULD advertise optional feature support in `host.capabilities`. This allows extensions to degrade gracefully when a host does not support prompts, context injection, or token budgeting.

Extensions MUST NOT assume capability support. They MUST check `sdk.host.capabilities.prompts === true` before calling `sdk.registerPrompt()`, for example.

---

## 12. Registry Protocol

The Extension Registry is an HTTP API for publishing, discovering, and installing extensions.

### 12.1 Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/extensions` | List extensions with pagination and filtering. |
| `GET` | `/extensions/:name` | Get extension metadata by scoped name. |
| `GET` | `/extensions/:name/:version` | Get a specific version. |
| `PUT` | `/extensions/:name` | Publish a new version. Requires authentication. |
| `DELETE` | `/extensions/:name/:version` | Unpublish a version. Requires authentication. |
| `GET` | `/extensions/:name/:version/download` | Download the package tarball. |
| `POST` | `/extensions/search` | Full-text search across extensions. |
| `GET` | `/extensions/:name/trust` | Get trust tier and signing status. |
| `GET` | `/extensions/:name/did` | Resolve extension DID document. |
| `POST` | `/extensions/:name/verify` | Verify an extension's VC. |

### 12.2 Package Format

Extensions are distributed as gzipped tarballs (`.tgz`) containing:

```
package/
  plexo.json          # Manifest (required)
  dist/               # Built artifacts (required)
    index.js           # Entry point
  README.md           # Description (optional)
  LICENSE             # License file (recommended)
  icon.png            # Icon (optional)
```

The `plexo.json` manifest MUST be at the package root.

### 12.3 Security Scanning

Before a published extension is made available:

1. Registry MUST validate the manifest against the schema.
2. Registry MUST scan the package for known vulnerabilities (dependency audit).
3. Registry MUST verify the package does not contain known malicious patterns.
4. Registry SHOULD compute and store a SHA-256 hash of the package.
5. For verified-tier extensions, registry MUST require code review by a trusted reviewer.

### 12.4 Federation

Registries MAY federate with each other. A host can be configured with multiple registry endpoints. When resolving an extension:

1. Host queries registries in configured priority order.
2. First registry returning a valid result wins.
3. Trust tier is determined by the registry that hosts the extension (verified status is registry-specific).
4. DID resolution follows the extension's `did` field to the issuing registry.

---

## 13. Security Requirements

### 13.1 Credential Handling

1. Connection credentials MUST be stored encrypted at rest by the host.
2. Credentials MUST be delivered to extensions via `sdk.connections.getCredentials()` only for declared connections.
3. Extensions MUST NOT log, persist, or transmit credentials outside their declared `dataResidency` destinations.
4. Hosts MUST rotate credentials when an extension is uninstalled.
5. OAuth2 token refresh MUST be handled by the host, not the extension.

### 13.2 Code Execution Safety

1. Extension code runs in sandboxed workers with no access to the host process.
2. Extensions MUST NOT have access to the file system, environment variables, or host configuration.
3. `eval()`, `new Function()`, and dynamic import of URLs MUST be blocked in the sandbox.
4. Extensions MUST NOT spawn child processes.
5. WebAssembly execution is permitted within the sandbox.

### 13.3 Registry Security

1. All registry communication MUST use HTTPS.
2. Package publishing MUST require authentication (API key or OAuth2).
3. Published packages MUST be signed by the publisher's key.
4. Hosts MUST verify package signatures before installation.
5. Hosts MUST verify package integrity (SHA-256 hash) after download.

### 13.4 Transport Security

1. All communication between host and extension workers uses structured message passing (not raw TCP/HTTP).
2. Cross-host communication (A2A, DID resolution, registry) MUST use TLS 1.2+.
3. External webhook endpoints registered by channel extensions MUST use HTTPS.
4. Hosts MUST validate TLS certificates and MUST NOT allow self-signed certificates in production.

---

## 14. Compliance Levels

Hosts declare a compliance level that determines which features they must implement.

### 14.1 Core

The minimum viable host. Suitable for simple tool/extension hosting without autonomous agents.

**Required:**

- Manifest validation (section 3)
- Capability token enforcement (section 4)
- Worker isolation (section 5)
- Message protocol (section 6)
- Tool Registry (section 7.1)
- Event Bus with standard topics (section 7.4)
- Memory Layer (unscoped tokens accepted) (section 7.5)
- Basic storage (section 7, storage API)
- Connection management
- Lifecycle hooks: activate / deactivate (section 9)
- Error handling with all error codes (section 10)
- Legacy type mapping (`function` -> `skill`, `mcp-server` -> `connector`)

**Not required:**

- Task Router
- Channel Router
- Agent Contract
- Prompt Library
- Context Layer
- Entity schema
- Trust tier enforcement
- Audit trail
- Data residency enforcement
- UserSelf
- DID / VC
- A2A Bridge
- Escalation Contract
- Model context

### 14.2 Standard

Full extension support with entity-scoped memory and trust enforcement.

**Required (all Core requirements plus):**

- Entity-scoped memory enforcement (section 4.2)
- Task Router (section 7.2)
- Channel Router (section 7.3)
- Agent Contract (section 8)
- Prompt Library (section 7.6)
- Context Layer (section 7.7)
- Personal Entity Schema (section 16)
- Trust tier enforcement (section 17)
- Audit trail (section 18)
- Data residency enforcement (section 19)
- Escalation Contract with IRREVERSIBLE_ACTION and CAPABILITY_EXPANSION triggers (section 23)
- Model context in audit entries (section 24)
- Registry Protocol support (section 12)

### 14.3 Full

Enterprise-grade host with identity, cross-host interop, and complete governance.

**Required (all Standard requirements plus):**

- UserSelf persistent identity graph (section 20)
- DID + Verifiable Credentials (section 21)
- A2A Bridge Layer (section 22)
- All escalation triggers (section 23)
- Network-level data residency enforcement (section 19)
- Service Discovery (section 25)
- Registry federation (section 12.4)
- Standing approval rules (section 23)
- Selective disclosure for VCs (section 21)
- Token budgeting for context layer (section 7.7.6)

---

## 16. Personal Entity Schema

Standard first-class personal entity types all Plexo-compatible hosts at Standard and Full compliance must support. Entity resolution prevents data fragmentation when multiple extensions reference the same person, task, or thread.

### 16.1 Entity Types

| Type | Key Fields | Description |
|------|-----------|-------------|
| `person` | name, email[], phone[], tags[], source | A human contact. |
| `task` | title, status, due, assignee, tags[] | A unit of work. |
| `thread` | participants[], subject, channel, lastActivity | A conversation. |
| `note` | body, tags[], createdAt | A piece of text. |
| `transaction` | amount, currency, direction, merchant, category, date | A financial record. |
| `calendar_event` | title, start, end, attendees[], location | A scheduled event. |
| `file` | name, type, mimeType, sizeBytes, capturedAt, source, storageUri, checksum | A stored file. |

### 16.2 Entity Rules

1. Entity IDs are host-scoped UUIDs, stable across sessions.
2. Extensions reference entities by ID. Extensions MUST NOT duplicate entity data.
3. All entities support `linkedEntities?: LinkedEntity[]` for cross-entity linking.
4. Cross-entity linking uses typed references:

```typescript
interface LinkedEntity {
  type: EntityTypeName
  id: string
}
```

### 16.3 Entity Union

```typescript
type PlexoEntity =
  | PersonEntity
  | TaskEntity
  | ThreadEntity
  | NoteEntity
  | TransactionEntity
  | CalendarEventEntity
  | FileEntity
```

### 16.4 Entity Type Map

```typescript
interface EntityTypeMap {
  person: PersonEntity
  task: TaskEntity
  thread: ThreadEntity
  note: NoteEntity
  transaction: TransactionEntity
  calendar_event: CalendarEventEntity
  file: FileEntity
}
```

### 16.5 Entity Resolution API

Hosts MUST provide the following API via the SDK:

```typescript
sdk.entities.resolve<T>(type: T, id: string): Promise<EntityTypeMap[T] | null>
sdk.entities.search<T>(type: T, query: EntitySearchQuery): Promise<EntitySearchResult<EntityTypeMap[T]>>
sdk.entities.create<T>(type: T, data: Omit<EntityTypeMap[T], 'id'>): Promise<EntityTypeMap[T]>
sdk.entities.link(source, target: LinkedEntity): Promise<void>
```

Search query:

```typescript
interface EntitySearchQuery {
  text?: string
  tags?: string[]
  limit?: number
  offset?: number
}

interface EntitySearchResult<T> {
  entities: T[]
  total: number
  hasMore: boolean
}
```

### 16.6 Capability Tokens

| Token | Description |
|-------|-------------|
| `memory:read:<entity_type>` | Read entities and memory entries of this type. |
| `memory:write:<entity_type>` | Write memory entries for this type. |
| `entity:create:<entity_type>` | Create new entities of this type. |
| `entity:modify:<entity_type>` | Modify existing entities of this type. |
| `entity:delete:<entity_type>` | Delete entities of this type. |

---

## 17. Trust Tiers

Extensions are classified into three trust tiers that determine their capability ceilings.

### 17.1 Tier Definitions

| Tier | Who | Capability Ceiling |
|------|-----|-------------------|
| `owner` | Built and signed by the host operator. | Full: `memory:read:*`, `audit:read`, entity creation, `model:override`. |
| `verified` | Reviewed and signed by the Plexo registry. | Standard caps, no wildcard memory, no audit access. |
| `community` | Unreviewed public extensions. | Restricted caps, explicit user approval per capability token. |

### 17.2 Capability Ceilings

```typescript
interface TrustTierCeilings {
  owner: {
    allowWildcardMemory: true
    allowAuditRead: true
    allowEntityCreation: true
    allowModelOverride: true
  }
  verified: {
    allowWildcardMemory: false
    allowAuditRead: false
    allowEntityCreation: true
    allowModelOverride: false
  }
  community: {
    allowWildcardMemory: false
    allowAuditRead: false
    allowEntityCreation: false
    allowModelOverride: false
  }
}
```

### 17.3 Enforcement Rules

1. Hosts MUST declare a trust tier policy in their compliance declaration.
2. `plexo.json` MAY declare `trust: 'owner'` -- the host validates against its signing key.
3. Capability tokens exceeding the declared tier MUST be rejected at install time, not runtime.
4. Community-tier extensions require explicit user approval for each capability token at install.
5. Verified-tier status is issued by the registry. The host verifies the signature against the registry endpoint.

### 17.4 Trust Tier Policy

```typescript
interface TrustTierPolicy {
  defaultTier: TrustTier
  enforceTierCeilings: boolean
  ownerSigningKeyId?: string
  registryEndpoint?: string
}
```

---

## 18. Audit Trail

Standard and Full compliance hosts MUST maintain an immutable audit ledger per extension per session.

### 18.1 Immutable Ledger

Every action performed by an extension or agent is logged:

```typescript
interface AuditEntry {
  extensionId: string
  agentId?: string            // Which agent invoked this extension, if any
  sessionId: string
  timestamp: string           // ISO 8601
  action: AuditAction
  target: string              // Entity ID, function name, channel, or external URL
  payloadHash: string         // SHA-256 of input, not plaintext
  outcome: AuditOutcome
  modelContext?: ModelContextEntry   // Section 24
  escalationOutcome?: EscalationOutcome
}
```

### 18.2 Audit Actions

| Action | Description |
|--------|-------------|
| `function_invoked` | A tool was called. |
| `memory_read` | Memory was queried. |
| `memory_write` | Memory was written. |
| `channel_send` | Message sent via channel. |
| `schedule_fired` | Scheduled job executed. |
| `entity_created` | New entity created. |
| `entity_modified` | Entity modified. |
| `external_request` | HTTP request to external service. |
| `escalation_triggered` | Escalation was triggered. |
| `escalation_resolved` | Escalation was resolved by user. |

### 18.3 Audit Outcomes

| Outcome | Description |
|---------|-------------|
| `success` | Action completed successfully. |
| `failure` | Action failed. |
| `denied` | Action denied by capability enforcement or escalation. |

### 18.4 Rules

1. `audit:read` capability required for owner-tier extensions to query the ledger.
2. Ledger entries MUST be immutable. No extension modifies or deletes its own trail.
3. Hosts MUST surface audit logs in admin UI.
4. Audit log data residency follows the host's declared policy (section 19).
5. Payload hashes (SHA-256) are stored, not plaintext inputs, to preserve privacy.

### 18.5 Query API

```typescript
sdk.audit.query(query: AuditQuery): Promise<AuditQueryResult>

interface AuditQuery {
  extensionId?: string
  agentId?: string
  sessionId?: string
  action?: AuditAction
  outcome?: AuditOutcome
  from?: string          // ISO 8601 range start
  to?: string            // ISO 8601 range end
  limit?: number
  offset?: number
}

interface AuditQueryResult {
  entries: AuditEntry[]
  total: number
  hasMore: boolean
}
```

---

## 19. Data Residency

All extensions MUST declare external data destinations in their manifest.

### 19.1 Declaration

```typescript
interface DataResidencyDeclaration {
  sendsDataExternally: boolean
  externalDestinations?: ExternalDestination[]
}

interface ExternalDestination {
  host: string              // Hostname of the external service
  purpose: string           // Human-readable purpose
  dataTypes?: EntityTypeName[]  // Entity types sent to this destination
}
```

### 19.2 Rules

1. Extensions with `sendsDataExternally: false` making external HTTP calls MUST be flagged non-compliant at runtime.
2. Hosts MAY enforce an allowlist of permitted external destinations.
3. An omitted `dataResidency` field is treated as `sendsDataExternally: true` with unknown destinations -- blocked at Full compliance.
4. The declaration is surfaced verbatim to users at install.
5. At Full compliance, hosts MUST enforce network-level restrictions, not just SDK-level checks.

### 19.3 External Destinations

Each external destination declares:

- **host**: The hostname (e.g., `api.salesforce.com`).
- **purpose**: Why data is sent there (e.g., "CRM contact sync").
- **dataTypes**: Which entity types are transferred (e.g., `["person", "transaction"]`).

Hosts SHOULD display this information in a human-readable format at install time, allowing the user to make an informed decision.

---

## 20. UserSelf -- Persistent Identity Graph

A host-managed identity graph readable by owner and verified extensions with field-level scoping.

### 20.1 Structure

```typescript
interface UserSelf {
  identity: UserIdentity
  preferences: Record<string, unknown>
  relationships: string[]                    // Person entity IDs
  contexts: Record<string, UserContext>      // Named contexts: work, finance, health
  communicationStyle: UserCommunicationStyle
}

interface UserIdentity {
  name?: string
  timezone?: string
  locale?: string
  primaryEmail?: string
}

interface UserCommunicationStyle {
  formality?: 'casual' | 'neutral' | 'formal'
  verbosity?: 'concise' | 'moderate' | 'detailed'
  preferredChannels?: string[]
}

interface UserContext {
  summary: string
  lastUpdated: string   // ISO 8601
}
```

### 20.2 Field-Level Scoping

Extensions read specific fields:

```typescript
type UserSelfField = 'identity' | 'preferences' | 'relationships' | 'contexts' | 'communicationStyle'

sdk.self.read(fields: UserSelfField[]): Promise<Partial<UserSelf>>
```

The host returns only the requested fields. Extensions MUST NOT receive fields they did not request.

### 20.3 Proposals

Extensions contribute to the UserSelf graph via structured proposals:

```typescript
interface UserSelfProposal {
  field: UserSelfField
  path?: string            // Dot-path within the field, e.g. 'identity.timezone'
  value: unknown
  source: string           // Extension proposing this change
  confidence: number       // 0-1
}

sdk.self.propose(proposal: UserSelfProposal): Promise<void>
```

### 20.4 Conflict Resolution

The host resolves conflicting proposals using one of:

| Strategy | Description |
|----------|-------------|
| `last-write` | Most recent proposal wins. |
| `confidence-weighted` | Highest confidence proposal wins. |
| `user-confirmed` | User is prompted to resolve the conflict. |

The strategy is host-configured. Extensions cannot influence conflict resolution strategy.

### 20.5 Rules

1. UserSelf is host-owned. No extension owns it.
2. Extensions contribute via structured proposals only.
3. UserSelf persists across sessions and survives extension uninstall.
4. Capability tokens: `self:read`, `self:write`.
5. Agents read UserSelf to personalize behavior across all their loaded extensions.

---

## 21. DID + Verifiable Credentials

Each extension and agent MAY be assigned a W3C Decentralized Identifier (DID). Full compliance hosts MUST assign DIDs for any cross-host interaction.

### 21.1 DID Document

```typescript
interface PlexoDIDDocument {
  did: string                               // e.g. 'did:plexo:host-id:extension-id'
  publicKey: string                         // For signing and authentication
  serviceEndpoints?: Record<string, string>
  extensionManifest?: string                // URL resolving to plexo.json
  trustTier: TrustTier
  issuedBy: string                          // DID of the issuing host or registry
}
```

### 21.2 Verifiable Credentials

Hosts issue VCs at install time attesting to capability grants:

```typescript
interface PlexoVerifiableCredential {
  id: string
  type: 'VerifiableCredential' | 'PlexoCapabilityCredential'
  issuer: string              // DID of the host
  subject: string             // DID of the extension or agent
  issuanceDate: string        // ISO 8601
  expirationDate?: string     // ISO 8601
  capabilities: string[]      // Granted capability tokens
  proof: {
    type: string
    created: string
    proofPurpose: string
    verificationMethod: string
    jws: string               // Signature
  }
}
```

### 21.3 Selective Disclosure

Extensions can prove specific capabilities without revealing all grants:

```typescript
interface SelectiveDisclosureRequest {
  requestedCapabilities: string[]
  verifier: string             // DID of the requesting party
  nonce: string                // Replay prevention
}

interface SelectiveDisclosureResponse {
  credential: PlexoVerifiableCredential   // Derived credential proving only requested caps
  nonce: string
}
```

### 21.4 Rules

1. Extension and agent DIDs are resolvable via the Extension Registry Protocol (section 12).
2. Cross-host actions MUST be signed with the extension's or agent's private key.
3. Revoked or expired VCs cause immediate capability rejection with `DID_VERIFICATION_FAILED`.
4. Capability token: `identity:present` is required for cross-host interactions.
5. DID method: `did:plexo:<host-id>:<extension-id>`.

---

## 22. A2A Bridge Layer

Full compliance hosts MUST expose an A2A-compatible endpoint for each agent, enabling external A2A clients to discover and invoke Plexo agents as remote agents.

### 22.1 Agent Cards

Each Plexo agent is represented by an A2A Agent Card, auto-generated from the agent manifest:

```typescript
interface A2AAgentCard {
  name: string
  description: string
  version: string
  endpoint: string             // https://host/a2a/agents/:id
  capabilities: Record<string, unknown>
  authentication: {
    schemes: ('oauth2' | 'did' | 'api_key')[]
  }
  plexoDID?: string            // Plexo DID for this agent, if assigned
}
```

### 22.2 A2A Tasks

```typescript
interface A2ATask {
  id: string
  description: string
  input: unknown
  expectedOutput?: Record<string, unknown>
}

type A2ATaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

interface A2ATaskResult {
  taskId: string
  status: A2ATaskStatus
  output?: unknown
  error?: string
}
```

### 22.3 Delegation (Outbound)

Plexo agents delegate to external A2A agents via `sdk.a2a.delegate()`:

```typescript
interface A2ADelegation {
  targetEndpoint: string
  task: A2ATask
  timeoutMs?: number
}

sdk.a2a.discover(endpoint: string): Promise<A2AAgentCard | null>
sdk.a2a.delegate(delegation: A2ADelegation): Promise<A2ATaskResult>
```

Requires `a2a:delegate` capability. All delegations are logged in the audit trail.

### 22.4 Inbound Requests

External agents invoke Plexo agents via the host's A2A endpoint:

```typescript
interface A2AInboundRequest {
  sourceAgent: A2AAgentCard
  task: A2ATask
  credential?: unknown         // VC for elevated trust
}
```

Inbound tasks route through the host's Task Router with the same isolation and enforcement as internal tasks.

### 22.5 Trust Rules

1. External agents are treated as community trust tier unless presenting a VC elevating trust.
2. Inbound tasks go through the Task Router with full capability enforcement.
3. Delegated tasks are logged in the audit trail with the external agent's DID or endpoint.
4. Requires `a2a:delegate` capability token for outbound delegation.

---

## 23. Escalation Contract

A formal escalation contract all agent implementations MUST support. No formal spec for when an agent must pause and request human approval is a critical governance gap for autonomous software touching email, calendar, and finances.

### 23.1 Escalation Triggers

| Trigger | Description |
|---------|-------------|
| `HIGH_VALUE_ACTION` | Financial transactions above user-configured threshold. |
| `IRREVERSIBLE_ACTION` | Sending external comms, deleting data, publishing. |
| `NOVEL_PATTERN` | Action type not previously approved by this user. |
| `CONFIDENCE_BELOW` | Agent confidence score below host-configured threshold. |
| `CROSS_BOUNDARY` | Action affects entities outside the user's own data. |
| `CAPABILITY_EXPANSION` | Agent requests a capability not in its original grant. |

Hosts MUST implement at minimum `IRREVERSIBLE_ACTION` and `CAPABILITY_EXPANSION` at Standard compliance. Full compliance hosts MUST implement all triggers.

### 23.2 Escalation Flow

```typescript
interface EscalationRequest {
  trigger: EscalationTrigger
  action: string                // What the agent wants to do
  context: unknown              // Relevant context for user decision
  recommendation?: {
    decision: 'approve' | 'deny'
    reasoning: string
  }
}

type EscalationUserResponse = 'approve' | 'deny' | 'approve-and-remember'

interface EscalationResult {
  response: EscalationUserResponse
  feedback?: string
  respondedAt: string           // ISO 8601
}
```

1. Agent encounters a trigger condition or calls `sdk.escalate()`.
2. Host pauses agent execution.
3. Host presents the escalation to the user with action, context, and agent recommendation.
4. User responds: approve, deny, or approve-and-remember.
5. Host relays the result to the agent.
6. If approved, agent proceeds. If denied, agent aborts or replans.
7. If approve-and-remember, host creates a Standing Approval rule.

### 23.3 Standing Approvals

User-owned rules that pre-approve specific escalation patterns:

```typescript
interface StandingApproval {
  id: string
  trigger: EscalationTrigger
  actionPattern: string          // Pattern matching, e.g. 'channel:send to @internal/*'
  createdBy: 'user'             // Extensions CANNOT create these
  createdAt: string
  expiresAt?: string
}
```

Rules:

1. Standing approvals are user-owned. Extensions MUST NOT create or modify them.
2. Hosts match incoming escalations against standing approvals before prompting the user.
3. Expired standing approvals are automatically removed.
4. Hosts MUST surface all active standing approvals in the admin UI.

### 23.4 User Response Schema

| Response | Effect |
|----------|--------|
| `approve` | Action proceeds. No rule created. |
| `deny` | Action blocked. Logged as `ESCALATION_DENIED`. |
| `approve-and-remember` | Action proceeds. Standing approval created for this pattern. |

### 23.5 Timeout

If the user does not respond within the configured window (host-defined, recommended default: 5 minutes):

1. The escalation is denied by default.
2. The action is logged with code `ESCALATION_TIMEOUT`.
3. The agent receives `ESCALATION_TIMEOUT` and MUST abort or replan.

### 23.6 Anti-Circumvention

Extensions MUST NOT bypass escalation by splitting irreversible actions into smaller reversible steps. The host detects composite irreversibility by analyzing the aggregate effect of a plan's steps. If a sequence of individually reversible steps constitutes an irreversible outcome, the host MUST trigger `IRREVERSIBLE_ACTION`.

---

## 24. Model Context

When an agent acts, the LLM powering it must be visible to the audit trail, the user, and the system.

### 24.1 Model Requirements

Agent manifests MAY declare model requirements:

```typescript
interface ModelRequirements {
  minimumContextWindow?: number
  requiresFunctionCalling?: boolean
  localModelAcceptable?: boolean
  prohibitedProviders?: string[]
  preferredProviders?: string[]
}
```

Rules:

1. If `localModelAcceptable: false` and the host resolves to a cloud provider, the agent's `dataResidency` MUST list that provider as an external destination.
2. If host policy prohibits external model calls, agents declaring `localModelAcceptable: false` MUST be rejected at install.
3. Hosts MUST surface which model powers each active agent in admin UI.
4. Model changes require user re-acknowledgment for agents with `IRREVERSIBLE_ACTION` escalation triggers.
5. Capability token `model:override` is required for agents that dynamically select their own model at runtime.

### 24.2 Context Entries

Every audit entry MAY include a model context block:

```typescript
interface ModelContextEntry {
  modelId: string              // e.g. 'claude-sonnet-4-5', 'llama-3.3-70b'
  modelVersion?: string        // Exact version or hash if self-hosted
  modelProvider: string        // e.g. 'anthropic', 'openai', 'ollama', 'self-hosted'
  isLocal: boolean             // true if on-host, false if external API
  contextWindowUsed?: number   // Tokens used in this call
}
```

This enables:

- Reproducibility: knowing which model produced which decision.
- Compliance: proving data was processed locally vs. sent to a cloud provider.
- Debugging: understanding model-specific behavior differences.

---

## 25. Service Discovery

Any service supporting Plexo natively MUST expose a well-known endpoint for automatic detection.

### 25.1 Well-Known Endpoint

```
GET /.well-known/plexo.json
```

Response:

```typescript
interface WellKnownPlexo {
  plexo: string                    // Fabric spec version
  name: string                     // Service display name
  did?: string                     // W3C DID
  capabilities: {
    offered?: string[]             // Connection identifiers offered
    extensions?: WellKnownExtensionRef[]  // Pre-built extensions
  }
  dataResidency?: {
    sendsDataExternally: boolean
    regions?: string[]
  }
  auth: {
    schemes: ('oauth2' | 'api_key' | 'did')[]
    oauth2?: {
      authorizationUrl: string
      tokenUrl: string
    }
  }
  escalation?: {
    supportsEscalationCallbacks: boolean
    webhookEndpoint?: string
  }
}

interface WellKnownExtensionRef {
  name: string                     // Scoped extension name
  registry: string                 // Registry URL
}
```

### 25.2 Detection Flow

1. User initiates a Connection to an external service.
2. Host pings `{serviceBaseUrl}/.well-known/plexo.json`.
3. **Valid manifest** -> Plexo-native: verify DID, surface shield badge, full disclosure pre-connection.
4. **404 or invalid** -> Standard Connection: no badge, OAuth/API key fallback, manual trust assumed.

### 25.3 Requirements

1. MUST be served over HTTPS, publicly accessible, no authentication required.
2. MUST return `Content-Type: application/json`.
3. Response MUST validate against the Plexo manifest schema.
4. DID, if present, MUST resolve via the Extension Registry.

### 25.4 Discovery Result

```typescript
type ServiceDiscoveryResult =
  | { native: true; manifest: WellKnownPlexo }
  | { native: false; reason: 'not_found' | 'invalid_manifest' | 'network_error' }
```

---

## Appendix A: PlexoSDK Interface

The complete TypeScript interface available to extensions and agents via the `sdk` parameter in `activate()`.

```typescript
type NotificationLevel = 'info' | 'warning' | 'error'
type ExtensionName = `@${string}/${string}`

interface HostInfo {
  fabricVersion: string
  complianceLevel: HostComplianceLevel
  name: string
  version: string
  capabilities?: { prompts?: boolean; context?: boolean; tokenBudgeting?: boolean }
}

interface MemoryEntry {
  id: string
  content: string
  tags?: string[]
  authorExtension: ExtensionName | 'host'
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
  ttl?: number
  entityType?: EntityTypeName
  entityId?: string
}

interface ConnectionCredentials {
  type: 'api_key' | 'oauth2' | 'basic' | 'webhook'
  data: Record<string, string>
}

interface ScheduleRegistration {
  name: string
  schedule: string           // 5-field cron expression
  timezone?: string          // IANA timezone. Defaults to 'UTC'.
  handler(): Promise<void>
}

interface WidgetRegistration {
  name: string
  displayName: string
  displayType: 'metric' | 'chart' | 'list' | 'status' | 'custom'
  refreshInterval: number    // Seconds
  dataHandler(config: unknown): Promise<unknown>
}

interface ToolRegistration {
  name: string               // Alphanumeric and underscores. Unique within extension.
  description: string        // Max 500 characters.
  parameters: JSONSchema     // Must be type "object" at top level.
  hints?: {
    estimatedMs?: number
    timeoutMs?: number       // Hard timeout. Defaults to 30,000.
    hasSideEffects?: boolean
    idempotent?: boolean
  }
  handler(params: unknown, context: InvokeContext): Promise<unknown>
}

interface InvokeContext {
  workspaceId: string
  taskId?: string
  requestId: string
}

interface ToolSummary {
  name: string
  description: string
  ownerExtension: string
}

interface TaskCreateOptions {
  title: string
  type: string
  context?: unknown
}

interface TaskFilter {
  status?: string
  type?: string
}

interface PlexoSDK {
  host: HostInfo

  // Registration (valid during activate() only)
  registerTool(tool: ToolRegistration): void
  registerSchedule(job: ScheduleRegistration): void
  registerWidget(widget: WidgetRegistration): void
  registerPrompt(prompt: PromptRegistration): void       // Requires prompts:register
  registerContext(context: ContextRegistration): void     // Requires context:register

  // Memory (entity-scoped at Standard + Full compliance)
  memory: {
    read(query: string, options?: {
      tags?: string[]
      limit?: number
      entityType?: EntityTypeName
    }): Promise<MemoryEntry[]>
    write(entry: {
      content: string
      tags?: string[]
      metadata?: Record<string, unknown>
      ttl?: number
      entityType?: EntityTypeName
      entityId?: string
    }): Promise<MemoryEntry>
    delete(id: string): Promise<void>
  }

  // Personal Entity Resolution API (section 16)
  entities: {
    resolve<T extends EntityTypeName>(type: T, id: string): Promise<EntityTypeMap[T] | null>
    search<T extends EntityTypeName>(type: T, query: EntitySearchQuery): Promise<EntitySearchResult<EntityTypeMap[T]>>
    create<T extends EntityTypeName>(type: T, data: Omit<EntityTypeMap[T], 'id'>): Promise<EntityTypeMap[T]>
    link(source: { type: EntityTypeName; id: string }, target: LinkedEntity): Promise<void>
  }

  // Connections
  connections: {
    getCredentials(service: string): Promise<ConnectionCredentials>
    isConnected(service: string): Promise<boolean>
  }

  // Channel
  channel: {
    send(message: { text: string; priority?: 'normal' | 'high' | 'urgent'; attachments?: unknown[] }): Promise<void>
    sendDirect(channelId: string, message: unknown): Promise<void>
  }

  // Tasks
  tasks: {
    create(options: TaskCreateOptions): Promise<{ taskId: string }>
    get(taskId: string): Promise<unknown>
    list(filter?: TaskFilter): Promise<unknown[]>
  }

  // Events
  events: {
    subscribe(topic: string, handler: (payload: unknown) => void): void
    publish(topic: string, payload: unknown): Promise<void>
  }

  // Storage
  storage: {
    get(key: string): Promise<string | null>
    set(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>
    delete(key: string): Promise<void>
  }

  // UI
  ui: {
    notify(message: string, level?: NotificationLevel): Promise<void>
  }

  // UserSelf (section 20)
  self: {
    read(fields: UserSelfField[]): Promise<Partial<UserSelf>>
    propose(proposal: UserSelfProposal): Promise<void>
  }

  // Audit Trail (section 18, owner tier only)
  audit: {
    query(query: AuditQuery): Promise<AuditQueryResult>
  }

  // Escalation (section 23, agent type only)
  escalate(request: EscalationRequest): Promise<EscalationResult>

  // A2A Bridge (section 22, Full compliance hosts)
  a2a: {
    discover(endpoint: string): Promise<A2AAgentCard | null>
    delegate(delegation: A2ADelegation): Promise<A2ATaskResult>
  }

  // Prompt Library (section 7.6)
  prompts: {
    list(options?: { tags?: string[] }): Promise<PromptSummary[]>
    resolve(promptId: string, variables?: Record<string, unknown>): Promise<string>
  }

  // Context Layer (section 7.7)
  context: {
    update(contextId: string, content: string, options?: { ttl?: number; estimatedTokens?: number }): Promise<void>
    list(): Promise<ContextSummary[]>
  }
}
```

---

## Appendix B: Interaction Matrix

This matrix shows which subsystems each extension type interacts with.

| Subsystem | skill | channel | tool | connector | agent |
|-----------|-------|---------|------|-----------|-------|
| Tool Registry | Register + Invoke | -- | Register | Register (proxy) | Invoke |
| Task Router | -- | -- | -- | -- | Claim + Create |
| Channel Router | -- | Full lifecycle | -- | -- | Send via SDK |
| Event Bus | Subscribe + Publish | Subscribe | Subscribe | -- | Subscribe + Publish |
| Memory Layer | Read + Write | Read + Write | Read | -- | Read + Write |
| Prompt Library | Register + Read | -- | Register + Read | -- | Register + Read + Resolve |
| Context Layer | Register + Write + Read | -- | Register + Write + Read | -- | Register + Write + Read |
| Entity API | Resolve + Search + Create + Link | Resolve + Search | Resolve + Search | -- | Resolve + Search + Create + Link |
| Storage | Read + Write | Read + Write | -- | -- | Read + Write |
| Connections | Get credentials | Get credentials | Get credentials | Get credentials | Get credentials |
| UserSelf | Read + Propose | -- | -- | -- | Read + Propose |
| Audit Trail | Query (owner) | -- | -- | -- | Query (owner) |
| Escalation | -- | -- | -- | -- | Trigger + Respond |
| A2A Bridge | -- | -- | -- | -- | Discover + Delegate |

---

## Appendix C: Extension Type Quick Reference

### skill

- **Purpose**: Composite capability package.
- **Manifest type**: `skill`
- **Legacy type**: `function`
- **Registers**: Tools, schedules, widgets, prompts, context blocks.
- **Config field**: `skillConfig` (JSONSchema, rendered as settings form).
- **Min host level**: Core.
- **Key capabilities**: `memory:*`, `connections:*`, `events:*`, `storage:*`, `ui:*`, `schedule:*`, `prompts:*`, `context:*`.

### channel

- **Purpose**: Messaging bridge.
- **Manifest type**: `channel`
- **Registers**: Nothing (implements Channel Contract).
- **Config field**: `channelConfig` (JSONSchema, rendered as setup form).
- **Min host level**: Core.
- **Key capabilities**: `channel:send`, `channel:receive`, `connections:*`, `memory:*`.
- **Required interface**: `onActivate()`, `onMessage()`, `healthCheck()`, `onDeactivate()`.

### tool

- **Purpose**: Stateless, single-purpose function.
- **Manifest type**: `tool`
- **Registers**: One tool.
- **Config field**: `toolConfig` (JSONSchema, rendered as settings form).
- **Min host level**: Core.
- **Key capabilities**: `connections:*`, `prompts:*`, `context:*`.
- **Constraints**: No persistent state, no schedules, no widgets.

### connector

- **Purpose**: Bridges an external MCP server.
- **Manifest type**: `connector`
- **Legacy type**: `mcp-server`
- **Registers**: Tools (proxied from MCP server).
- **Config field**: `mcpServer` (required).
- **Min host level**: Core.
- **Key capabilities**: `connections:*`.
- **Constraints**: Transport must be `stdio` or `sse`.

### agent

- **Purpose**: Autonomous actor with planning loop.
- **Manifest type**: `agent`
- **Pillar**: Agent (not Extension).
- **Registers**: Prompts, context blocks.
- **Config field**: `agentHints`, `behaviorRules`, `escalation`, `modelRequirements`.
- **Min host level**: Standard.
- **Key capabilities**: `tasks:create`, `events:*`, `memory:*`, `self:*`, `a2a:delegate`, `model:override`.
- **Required interface**: `shouldActivate()`, `plan()`, `executeStep()`, `verifyStep()`, `onEscalation()`.
- **Subject to**: Escalation Contract (section 23), Model Context (section 24).

---

*End of Plexo Fabric Specification v0.4.0*
