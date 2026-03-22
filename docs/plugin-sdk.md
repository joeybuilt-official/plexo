# Kapsel Extension SDK

## Overview

The Plexo Extension SDK (`@plexo/sdk`) enables third-party extensions to add functions, channels, MCP servers, schedules, widgets, and more. Extensions run in isolated Node.js worker threads — a crash never affects the core process.

Plexo implements the [Kapsel Protocol v0.3.0](https://github.com/joeybuilt-official/kapsel).

## Three Pillars

Kapsel defines three distinct architectural pillars:

| Pillar | What it is | Manifest type |
|--------|-----------|---------------|
| **Connection** | Authenticated pipe to an external service. Inert on its own. | N/A (host-managed) |
| **Extension** | Capability package — functions, schedules, widgets, memory access. | `function` · `channel` · `mcp-server` |
| **Agent** | Autonomous actor with a goal, planning loop, and identity. Orchestrates Extensions. | `agent` |

## Installation

```bash
npm install @plexo/sdk
```

## Quick Start

```typescript
import type { KapselSDK } from '@plexo/sdk'

export async function activate(sdk: KapselSDK): Promise<void> {
  // Register a function the agent can call
  sdk.registerTool({
    name: 'stripe_mrr_report',
    description: 'Generate a Stripe MRR report for a date range',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date (ISO 8601)' },
        to: { type: 'string', description: 'End date (ISO 8601)' },
      },
      required: ['from', 'to'],
    },
    handler: async ({ from, to }, ctx) => {
      const creds = await sdk.connections.getCredentials('stripe')
      const data = await fetchStripeData(creds, from, to)
      return { mrr: data.mrr, period: `${from} to ${to}` }
    },
  })

  // Schedule a recurring task
  sdk.registerSchedule({
    name: 'daily-mrr-check',
    schedule: '0 9 * * *',
    timezone: 'America/New_York',
    async handler() {
      const creds = await sdk.connections.getCredentials('stripe')
      const data = await fetchStripeData(creds)
      await sdk.channel.send({ text: `Daily MRR: $${data.mrr}` })
    },
  })

  // Resolve a canonical entity (§16)
  const person = await sdk.entities.resolve('person', contactId)

  // Read UserSelf for personalization (§20)
  const { identity } = await sdk.self.read(['identity'])
}
```

## Extension Manifest (`kapsel.json`)

Every extension requires a `kapsel.json` manifest:

```json
{
  "kapsel": "0.3.0",
  "name": "@acme/stripe-monitor",
  "version": "1.0.0",
  "type": "function",
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
  "trust": "verified",
  "dataResidency": {
    "sendsDataExternally": true,
    "externalDestinations": [
      {
        "host": "api.stripe.com",
        "purpose": "Payment data retrieval",
        "dataTypes": ["transaction"]
      }
    ]
  },
  "escalation": {
    "irreversibleActions": ["channel:send"],
    "requestsStandingApprovals": true
  },
  "resourceHints": {
    "maxInvocationMs": 30000
  }
}
```

### Manifest Type Field

| Type | Description |
|------|-------------|
| `function` | Stateless, single-purpose, called on demand |
| `channel` | Messaging bridge (inbound/outbound) |
| `mcp-server` | Model Context Protocol server |
| `agent` | Autonomous actor (separate pillar) |

### Capability Tokens

Memory capabilities are entity-scoped at Standard and Full compliance hosts:

```
memory:read:person          memory:write:person
memory:read:task            memory:write:task
memory:read:thread          memory:write:thread
memory:read:note            memory:write:note
memory:read:transaction     memory:write:transaction
memory:read:calendar_event  memory:write:calendar_event
```

Other capabilities: `channel:send`, `schedule:register`, `tasks:create`, `events:publish`, `storage:read`, `storage:write`, `self:read`, `self:write`, `audit:read`, `identity:present`, `a2a:delegate`, `model:override`.

## SDK API Reference

### Registration (during `activate()` only)

- `sdk.registerTool(tool)` — Register a callable function
- `sdk.registerSchedule(job)` — Register a cron schedule
- `sdk.registerWidget(widget)` — Register a dashboard widget

### Memory

- `sdk.memory.read(query, options?)` — Search memory entries
- `sdk.memory.write(entry)` — Write a memory entry
- `sdk.memory.delete(id)` — Delete a memory entry

### Entity Resolution (§16)

- `sdk.entities.resolve(type, id)` — Resolve a single entity
- `sdk.entities.search(type, query)` — Search entities
- `sdk.entities.create(type, data)` — Create a new entity
- `sdk.entities.link(source, target)` — Link two entities

### UserSelf (§20)

- `sdk.self.read(fields)` — Read user identity graph fields
- `sdk.self.propose(proposal)` — Propose a change to UserSelf

### Connections

- `sdk.connections.getCredentials(service)` — Get connection credentials
- `sdk.connections.isConnected(service)` — Check connection status

### Channel

- `sdk.channel.send(message)` — Send a message to the conversation
- `sdk.channel.sendDirect(channelId, message)` — Send to a specific channel

### Tasks

- `sdk.tasks.create(options)` — Create a new task
- `sdk.tasks.get(taskId)` — Get task details
- `sdk.tasks.list(filter?)` — List tasks

### Events

- `sdk.events.subscribe(topic, handler)` — Subscribe to host events
- `sdk.events.publish(topic, payload)` — Publish to `ext.<scope>.*` namespace

### Storage

- `sdk.storage.get(key)` — Get a stored value
- `sdk.storage.set(key, value, options?)` — Set a value with optional TTL
- `sdk.storage.delete(key)` — Delete a value

### Escalation (§23, Agent type)

- `sdk.escalate(request)` — Request human approval before proceeding

### Audit (§18, Owner tier)

- `sdk.audit.query(query)` — Query the immutable audit ledger

### A2A Bridge (§22)

- `sdk.a2a.discover(endpoint)` — Discover an external A2A agent
- `sdk.a2a.delegate(delegation)` — Delegate a task to an external agent

## Crash Policy

If an extension crashes:
1. Automatic restart with 5-second backoff
2. Maximum 3 restarts per hour
3. If exceeded, extension is disabled and operator is notified
4. Core process is never affected
