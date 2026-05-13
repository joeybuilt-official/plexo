<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Plexo Application eXchange (PAX) Protocol Specification

**Version:** 0.1.0
**Status:** Draft
**Date:** 2026-03-29

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in [RFC 2119][rfc2119].

[rfc2119]: https://datatracker.ietf.org/doc/html/rfc2119

---

## §1 — Purpose and Scope

PAX defines how external applications consume a Plexo instance as their
intelligence layer. A PAX app runs outside Plexo and uses Plexo for
inference, memory, events, entities, agents, and connection proxying.

PAX is one of four integration boundaries in the Plexo architecture:

| Protocol | Direction | Runtime | Purpose |
|----------|-----------|---------|---------|
| **PAX** | App → Plexo | External process | External apps consume Plexo services |
| **PEX** | Extension inside Plexo | Host sandbox | Extensions run inside the Plexo host |
| **MCP** | Tool ↔ Agent | Co-located or remote | Tools expose capabilities to agents |
| **A2A** | Agent ↔ Agent | Federated | Agents collaborate across trust boundaries |

PAX apps are consumers. They do not extend the host runtime, register
tools, or modify agent behavior. They call Plexo APIs with a scoped
bearer token issued at registration time.

---

## §2 — Definitions

**PAX App** — An external application that consumes Plexo services via
the PAX protocol. Identified by a scoped name (`@scope/name` or plain
`name`).

**PAX Manifest (`pax.json`)** — A declarative file shipped with the app
that describes its identity, requested capabilities, namespaces, and
event subscriptions.

**PAX Token** — A bearer token issued by a Plexo host at registration
time. Workspace-scoped, capability-constrained, rotatable, revocable.
Stored in the host's `mcp_tokens` table with `type = 'pax'`.

**Plexo Host** — The Plexo instance that validates manifests, issues
tokens, enforces capabilities, and serves PAX API surfaces.

**Namespace** — A scoping prefix for memory and events. Declared in
`pax.json`, enforced by the host. Memory: `pax:<appName>`. Events:
`pax.<appName>.<eventName>`.

**Capability Token** — A permission string in `surface:action:scope`
format declaring what the app may do. Claimed in `pax.json`, granted
(or denied) at registration.

**Workspace** — The organizational unit in Plexo. Every PAX registration
is scoped to exactly one workspace.

---

## §3 — pax.json Manifest

Every PAX app MUST include a `pax.json` at its project root.

### §3.1 — Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `plexo` | `string` | PAX spec version. MUST be `"0.1.0"` for this spec. |
| `name` | `string` | App identifier. `@scope/name` or plain `name`. Lowercase, alphanumeric, hyphens allowed. |
| `version` | `string` | Semver version of the app. |
| `displayName` | `string` | Human-readable name for host UI. |
| `description` | `string` | One-line description of the app's purpose. |
| `author` | `string` | Author name or organization. |
| `license` | `string` | SPDX license identifier. |

### §3.2 — Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `capabilities` | `string[]` | `[]` | Capability tokens requested (§4). |
| `memoryNamespace` | `string` | `"pax:<name>"` | Memory namespace. MUST start with `pax:`. |
| `eventNamespace` | `string` | `"pax.<name>"` | Event namespace. MUST start with `pax.`. |
| `events.publishes` | `string[]` | `[]` | Event names this app publishes. |
| `events.subscribes` | `string[]` | `[]` | Event names this app subscribes to. |
| `dataResidency` | `DataResidencyDeclaration` | `null` | Same structure as PEX §19. |
| `entities` | `string[]` | `[]` | Entity types the app interacts with. |
| `workspace` | `string` | `null` | Target workspace ID (optional; can be provided at registration). |

### §3.3 — Validation

Hosts MUST validate the manifest at registration time (`POST /api/pax/register`),
not at first API call. A manifest that fails validation MUST be rejected with
`PAX_MANIFEST_INVALID` and the registration MUST NOT proceed.

Validation rules:
- `plexo` MUST be a supported spec version string.
- `name` MUST match `/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/`.
- `version` MUST be valid semver.
- All capability tokens MUST be from the vocabulary defined in §4.
- `memoryNamespace` if present MUST start with `pax:`.
- `eventNamespace` if present MUST start with `pax.`.
- Events in `publishes` and `subscribes` MUST be non-empty strings.

---

## §4 — Capability Tokens

Capability tokens follow the `surface:action:scope` format established
by the PEX specification.

### §4.1 — Full Token Vocabulary

| Token | Description |
|-------|-------------|
| `ai:complete` | Request LLM inference via the host's configured provider. |
| `ai:embed` | Request embedding generation. |
| `memory:read:<ns>` | Read from the declared memory namespace. |
| `memory:write:<ns>` | Write to the declared memory namespace. |
| `memory:search:<ns>` | Semantic search within the declared memory namespace. |
| `events:publish:<ns>` | Publish events under the declared event namespace. |
| `events:subscribe:<ns>` | Subscribe to events under the declared event namespace. |
| `entities:read:<type>` | Read entities of the specified type. |
| `entities:create:<type>` | Create entities of the specified type. |
| `agents:invoke` | Invoke a Plexo agent (routes through Task Router). |
| `connections:proxy:<id>` | Proxy a request through a named connection. |

Where `<ns>` is the app's declared namespace, `<type>` is an entity type
name (§2 of PEX), and `<id>` is a connection identifier.

### §4.2 — Capability Ceiling

Community apps (apps without verified publisher status) are subject to:

- `memory:write:*` (wildcard) — MUST NOT be granted without explicit
  host admin approval at registration time.
- `entities:create:*` (wildcard) — MUST NOT be granted without explicit
  host admin approval.
- `connections:proxy:*` (wildcard) — MUST NOT be granted without explicit
  host admin approval.

The host MAY implement additional ceiling rules.

---

## §5 — Registration Lifecycle

### §5.1 — Registration

```
POST /api/v1/pax/register
Content-Type: application/json
Authorization: Bearer <workspace-api-key>
X-Workspace-Id: <workspace-uuid>

Body: { manifest: <pax.json contents> }
```

The host MUST:
1. Validate the manifest per §3.3.
2. Check for registration conflicts (same `name` in the same workspace).
3. Check capability ceiling (§4.2).
4. Generate a PAX token (§5.2).
5. Store the registration record: app name, version, manifest SHA-256 hash,
   workspace ID, capabilities granted, token reference, issued-at timestamp.
6. Return the token (shown once) and registration metadata.

Response (201):
```json
{
  "ok": true,
  "appName": "@vela/budget",
  "token": "plx_...",
  "capabilities": ["ai:complete", "memory:read:pax:vela", "memory:write:pax:vela"],
  "expiresAt": "2026-06-27T00:00:00.000Z",
  "message": "Registration complete. Store this token securely — it will not be shown again."
}
```

### §5.2 — Token Structure

PAX tokens are stored in the host's `mcp_tokens` table with `type = 'pax'`.
They use the same hashing scheme as MCP tokens: `SHA-256(raw + salt)`.

Token properties:
- Workspace-scoped: valid only for the workspace specified at registration.
- Capability-constrained: `scopes` field contains the granted capability tokens.
- Default expiry: 90 days. Hosts MAY configure a different default.
- Rotatable via `POST /api/v1/pax/rotate`.
- Revocable via `DELETE /api/v1/pax/register/:appName`.

Apps MUST store tokens in environment variables, never in source code.

### §5.3 — Token Rotation

```
POST /api/v1/pax/rotate
Authorization: Bearer <current-pax-token>

Body: { appName: "<name>" }
```

The host MUST:
1. Validate the current token.
2. Generate a new token with the same capabilities.
3. Revoke the old token.
4. Update the registration record.
5. Return the new token.

### §5.4 — Revocation

```
DELETE /api/v1/pax/register/:appName
Authorization: Bearer <workspace-api-key>
X-Workspace-Id: <workspace-uuid>
```

The host MUST:
1. Mark the registration's `revoked_at` timestamp.
2. Mark the associated token as revoked in `mcp_tokens`.
3. Stop delivering events to the app.
4. Reject all subsequent API calls with `PAX_TOKEN_REVOKED`.

---

## §6 — SDK Surface (TypeScript-first, browser + Node)

All PAX API calls use `Authorization: Bearer <PAX Token>`. Enforcement
is server-side on every call.

### §6.1 — Inference

```typescript
plexo.ai.complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>
plexo.ai.embed(input: string | string[]): Promise<EmbeddingResult>
```

Requires: `ai:complete`, `ai:embed` respectively.

### §6.2 — Memory

```typescript
plexo.memory.write(content: string, metadata?: MemoryMetadata): Promise<MemoryEntry>
plexo.memory.read(id: string): Promise<MemoryEntry>
plexo.memory.search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
```

Requires: `memory:write:<ns>`, `memory:read:<ns>`, `memory:search:<ns>`.
All operations are namespace-constrained (§7).

### §6.3 — Events

```typescript
plexo.events.publish(eventName: string, payload: unknown): Promise<void>
plexo.events.subscribe(eventName: string, handler: EventHandler): Unsubscribe
```

Requires: `events:publish:<ns>`, `events:subscribe:<ns>`.
Event routing rules in §8.

### §6.4 — Entities

```typescript
plexo.entities.resolve(type: string, id: string): Promise<Entity>
plexo.entities.search(type: string, query: string): Promise<Entity[]>
plexo.entities.create(type: string, data: EntityData): Promise<Entity>
```

Requires: `entities:read:<type>`, `entities:create:<type>`.

### §6.5 — Agents

```typescript
plexo.agents.invoke(prompt: string, options?: InvokeOptions): Promise<TaskResult>
```

Requires: `agents:invoke`. Routes through the Task Router (§10).

### §6.6 — Connections

```typescript
plexo.connections.proxy(connectionId: string, request: ProxyRequest): Promise<ProxyResponse>
```

Requires: `connections:proxy:<id>`. Proxy model in §9.

---

## §7 — Memory Isolation

### §7.1 — Namespace Enforcement

The memory namespace is declared in `pax.json` (`memoryNamespace` field)
and defaults to `pax:<appName>`.

The host MUST:
- Tag all memory writes with the app's declared namespace.
- Reject reads targeting entries outside the declared namespace, regardless
  of what the token's capability claims contain.
- Return `PAX_NS_VIOLATION` (403) on namespace violations.

### §7.2 — Cross-App Sharing

Cross-app memory sharing is out of scope for PAX v0.1.0. A future v0.2
MAY introduce shared namespace grants with explicit bilateral consent.

---

## §8 — Event Routing

### §8.1 — Namespacing

Published events are namespaced as `pax.<appName>.<eventName>`.
The host MUST prepend the namespace if the app omits it.

### §8.2 — Routing Rules

- Events route identically to internal Plexo events through the event bus.
- Multiple PAX apps MAY subscribe to the same event.
- PAX apps MAY subscribe to PEX extension events if the publishing
  extension declared the event as subscribable.
- PEX extensions MAY subscribe to PAX app events via the same mechanism.

### §8.3 — Delivery Constraints

The host MUST NOT deliver events to apps that did not declare the
subscription in their `pax.json` `events.subscribes` array.

The host SHOULD deliver events at-least-once. Exactly-once delivery
is not guaranteed.

---

## §9 — Connection Proxy Model

### §9.1 — Credential Isolation

**Hard rule:** Plexo holds upstream credentials. PAX apps MUST NOT receive,
see, or infer upstream credentials at any point.

```typescript
plexo.connections.proxy(connectionId, {
    method: 'GET',
    path: '/v1/transactions',
    query: { limit: '50' },
})
```

The host:
1. Validates `connections:proxy:<id>` capability.
2. Resolves the connection's stored credentials.
3. Injects credentials into the upstream request.
4. Forwards the request to the upstream service.
5. Returns the upstream response to the PAX app.

### §9.2 — Audit Trail

The host MUST log every proxied call:
- App name
- Connection ID
- Timestamp
- Upstream response status code

The request body MUST NOT be logged unless workspace policy explicitly
enables request body logging.

### §9.3 — Wildcard Proxy

`connections:proxy:*` grants access to all connections in the workspace.
This capability MUST NOT be granted without explicit admin approval at
registration time (§4.2).

---

## §10 — Agent Invocation

### §10.1 — Task Routing

PAX agent invocations route through the same Task Router as all internal
Plexo tasks. The host MUST:

1. Validate the `agents:invoke` capability.
2. Create a task record with the PAX app name as the initiator.
3. Return the task ID to the app.
4. Label the task in the audit trail with the PAX app name.

### §10.2 — Task Lifecycle

The app receives a task ID and MAY:
- Poll task status via `GET /api/v1/tasks/:id`.
- Subscribe to task lifecycle events if `events:subscribe` is granted.

Results are returned as `TaskResult` — the same structure used for
internal tasks.

### §10.3 — Capability Denial

If the `agents:invoke` capability is missing, the host MUST reject the
request at routing time with `PAX_AGENT_CAP_DENIED` (403).

---

## §11 — MCP Server Integration

The Plexo MCP server exposes three PAX management tools. These are
additions to the existing MCP tool set — not a separate server.

### §11.1 — plexo_pax_register

```
Input:  { manifest_json: string }
Scope:  pax:manage
```

Parses and validates a pax.json manifest string, POSTs to
`/api/v1/pax/register`, and returns token info. The manifest is
validated client-side first, then server-side at the API.

### §11.2 — plexo_pax_status

```
Input:  { app_name: string }
Scope:  pax:read
```

Returns registration status and capability claims for the named app.

### §11.3 — plexo_pax_revoke

```
Input:  { app_name: string }
Scope:  pax:manage
```

Revokes a registered PAX app by name. Sets `revoked_at` on the
registration and marks the associated token as revoked.

---

## §12 — CLI Integration

The `plexo pax` subcommand group extends the existing Plexo CLI.

### §12.1 — plexo pax init

Interactive pax.json generator. Prompts for name, version, display name,
description, capabilities. Writes `./pax.json`.

### §12.2 — plexo pax validate

Validates `./pax.json` (or `--file <path>`) against the PAX JSON Schema.
Exits 0 on valid, 1 on invalid with diagnostic messages.

### §12.3 — plexo pax register

```
plexo pax register [--file <path>]
```

POSTs to `/api/v1/pax/register` with the manifest contents. Prints the
issued token. Optionally writes it to a `.env` file if `--save-token` is
passed.

### §12.4 — plexo pax status

```
plexo pax status <appName>
```

Displays registration info as a formatted table: app name, version,
capabilities, issued-at, last-used-at, expires-at, revoked status.

### §12.5 — plexo pax rotate

```
plexo pax rotate
```

Rotates the PAX token for the authenticated app. Requires the current
token in the profile or `PLEXO_TOKEN` env var.

### §12.6 — plexo pax revoke

```
plexo pax revoke <appName>
```

Revokes a PAX app registration. Requires workspace-level auth.

---

## §13 — Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `PAX_MANIFEST_INVALID` | 400 | Manifest failed validation (§3.3). `detail` contains specific failures. |
| `PAX_CAP_DENIED` | 403 | Requested capability exceeds ceiling (§4.2) or is not recognized. |
| `PAX_NS_VIOLATION` | 403 | Memory or event operation targeted a namespace outside declaration. |
| `PAX_TOKEN_EXPIRED` | 401 | PAX token has passed its expiry date. Rotate to renew. |
| `PAX_TOKEN_REVOKED` | 401 | PAX token was explicitly revoked. Re-register to obtain a new one. |
| `PAX_EVENT_NOT_DECLARED` | 403 | App attempted to publish/subscribe to an undeclared event. |
| `PAX_AGENT_CAP_DENIED` | 403 | `agents:invoke` capability not granted. |
| `PAX_PROXY_DENIED` | 403 | `connections:proxy` capability not granted for the specified connection. |
| `PAX_WORKSPACE_NOT_FOUND` | 404 | Target workspace does not exist or caller lacks access. |
| `PAX_REGISTRATION_CONFLICT` | 409 | An app with this name is already registered in the workspace. |

Error response shape:

```json
{
  "error": {
    "code": "PAX_MANIFEST_INVALID",
    "message": "Manifest field 'name' must match /^(@[a-z0-9-]+\\/)?[a-z0-9-]+$/",
    "detail": {
      "field": "name",
      "value": "Invalid Name!"
    }
  }
}
```

The `detail` field is OPTIONAL and capability-specific. It MUST NOT
contain secrets, tokens, or credential material.

---

## §14 — Compliance Levels

Hosts declare their PAX compliance level at `GET /api/v1/pax/info`.

### §14.1 — Basic

- Manifest validation at registration.
- Token issuance and revocation.
- `ai:complete` capability.
- `memory:read` and `memory:write` within declared namespace.

### §14.2 — Standard

Everything in Basic, plus:
- Event publishing and subscription.
- Entity read and create.
- Agent invocation via Task Router.

### §14.3 — Full

Everything in Standard, plus:
- Connection proxy model with audit trail.
- Namespace enforcement with `PAX_NS_VIOLATION` errors.
- Token rotation.
- Token expiry enforcement (default 90 days, configurable).

---

## §15 — Security Considerations

### §15.1 — Token Handling

PAX tokens are bearer tokens. Compromise of a token grants the attacker
all capabilities declared in the manifest for the token's workspace.

- Apps MUST store tokens in environment variables, never in source code
  or version control.
- Apps MUST NOT log their PAX token.
- Hosts SHOULD enforce token expiry (default: 90 days, configurable per
  workspace).

### §15.2 — Manifest Integrity

The host stores a SHA-256 hash of the manifest at registration time. If
a future version adds manifest re-validation on API calls, this hash
detects drift between the registered manifest and the app's current
behavior.

### §15.3 — Connection Proxy Security

The connection proxy model (§9) eliminates credential exfiltration for
upstream services. The PAX app never receives, transmits, or stores
upstream credentials. The host is the sole custodian.

### §15.4 — Rate Limiting

PAX tokens inherit the host's MCP token rate limiting (60 requests/minute
per token by default). Hosts MAY configure per-app rate limits.

---

## Appendix A — pax.json Annotated Example

```json
{
  "plexo": "0.1.0",
  "name": "@vela/budget",
  "version": "1.0.0",
  "displayName": "Vela Budget Tracker",
  "description": "Personal budgeting app powered by Plexo intelligence",
  "author": "Vela Labs",
  "license": "MIT",

  "capabilities": [
    "ai:complete",
    "memory:read:pax:vela",
    "memory:write:pax:vela",
    "memory:search:pax:vela",
    "events:subscribe:pax.fylo.expense_created",
    "agents:invoke"
  ],

  "memoryNamespace": "pax:vela",
  "eventNamespace": "pax.vela",

  "events": {
    "publishes": ["budget_exceeded", "category_updated"],
    "subscribes": ["pax.fylo.expense_created"]
  },

  "entities": ["transaction", "person"],

  "dataResidency": {
    "regions": ["us"],
    "compliance": []
  }
}
```

## Appendix B — Full Capability Token Reference

| Surface | Action | Scope | Description |
|---------|--------|-------|-------------|
| `ai` | `complete` | — | LLM inference |
| `ai` | `embed` | — | Embedding generation |
| `memory` | `read` | `<namespace>` | Read from memory |
| `memory` | `write` | `<namespace>` | Write to memory |
| `memory` | `search` | `<namespace>` | Semantic search in memory |
| `events` | `publish` | `<namespace>` | Publish events |
| `events` | `subscribe` | `<namespace>` | Subscribe to events |
| `entities` | `read` | `<entity_type>` | Read entities |
| `entities` | `create` | `<entity_type>` | Create entities |
| `agents` | `invoke` | — | Invoke agents via Task Router |
| `connections` | `proxy` | `<connection_id>` | Proxy upstream requests |

## Appendix C — SDK TypeScript Interface (types only)

```typescript
// SPDX-License-Identifier: AGPL-3.0-only

/** PAX SDK surface — types only. Implementation in @plexo/pax-sdk. */

export interface PaxClient {
    ai: {
        complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>
        embed(input: string | string[]): Promise<EmbeddingResult>
    }
    memory: {
        write(content: string, metadata?: MemoryMetadata): Promise<MemoryEntry>
        read(id: string): Promise<MemoryEntry>
        search(query: string, options?: SearchOptions): Promise<MemoryEntry[]>
    }
    events: {
        publish(eventName: string, payload: unknown): Promise<void>
        subscribe(eventName: string, handler: EventHandler): Unsubscribe
    }
    entities: {
        resolve(type: string, id: string): Promise<Entity>
        search(type: string, query: string): Promise<Entity[]>
        create(type: string, data: EntityData): Promise<Entity>
    }
    agents: {
        invoke(prompt: string, options?: InvokeOptions): Promise<TaskResult>
    }
    connections: {
        proxy(connectionId: string, request: ProxyRequest): Promise<ProxyResponse>
    }
}

export interface CompletionOptions {
    model?: string
    maxTokens?: number
    temperature?: number
    systemPrompt?: string
}

export interface CompletionResult {
    text: string
    model: string
    usage: { promptTokens: number; completionTokens: number }
}

export interface EmbeddingResult {
    embeddings: number[][]
    model: string
}

export interface MemoryMetadata {
    tags?: string[]
    type?: string
}

export interface MemoryEntry {
    id: string
    content: string
    tags: string[]
    type: string
    createdAt: string
}

export interface SearchOptions {
    limit?: number
    type?: string
}

export type EventHandler = (event: PaxEvent) => void | Promise<void>
export type Unsubscribe = () => void

export interface PaxEvent {
    name: string
    payload: unknown
    timestamp: string
    source: string
}

export interface Entity {
    id: string
    type: string
    data: Record<string, unknown>
}

export type EntityData = Record<string, unknown>

export interface InvokeOptions {
    type?: string
    priority?: 'low' | 'normal' | 'high'
    metadata?: Record<string, unknown>
}

export interface TaskResult {
    taskId: string
    status: string
    result?: unknown
}

export interface ProxyRequest {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
    path: string
    query?: Record<string, string>
    headers?: Record<string, string>
    body?: unknown
}

export interface ProxyResponse {
    status: number
    headers: Record<string, string>
    body: unknown
}
```
