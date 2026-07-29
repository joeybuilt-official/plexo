<!-- SPDX-License-Identifier: MIT -->

# PAX Worked Example: Vela Budget Tracker

Vela is a personal budgeting app that integrates Plexo as its intelligence
layer. It:

- Categorizes transactions using Plexo inference
- Stores learned user preferences in Plexo memory
- Receives expense events from Fylo via Plexo's event bus
- Invokes a Plexo agent to generate monthly spending summaries

---

## 1. Complete pax.json

```json
{
  "plexo": "0.1.0",
  "name": "@vela/budget",
  "version": "1.2.0",
  "displayName": "Vela Budget Tracker",
  "description": "Personal budgeting powered by Plexo intelligence",
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

---

## 2. Registration Output

```
$ plexo pax register --file pax.json

✓ Registered: @vela/budget

Token:        plx_7kQ9xR2mF4vN8pL1wT5yB3jH6cD0aE9gU2sK4nM7bX1zW5
Capabilities: ai:complete, memory:read:pax:vela, memory:write:pax:vela, memory:search:pax:vela, events:subscribe:pax.fylo.expense_created, agents:invoke
Expires:      6/27/2026

Registration complete. Store this token securely — it will not be shown again.
```

---

## 3. SDK Usage Examples

### 3a. Inference — Categorize a Transaction

```typescript
import { createPaxClient } from '@plexo/pax-sdk'

const plexo = createPaxClient({
  host: process.env.PLEXO_HOST!,
  token: process.env.PAX_TOKEN!,
})

// Categorize a transaction using Plexo inference
const result = await plexo.ai.complete(
  `Categorize this transaction into one of: groceries, dining, transport, entertainment, utilities, other.

Transaction: "WHOLE FOODS MKT #10234 - $47.82"

Return JSON: { "category": "...", "confidence": 0.0-1.0 }`,
  { temperature: 0, maxTokens: 100 }
)

const classification = JSON.parse(result.text)
// { category: "groceries", confidence: 0.95 }
```

### 3b. Memory — Store User Preference

```typescript
// Store a learned spending preference
await plexo.memory.write(
  'User prefers to track coffee shop purchases separately from dining. ' +
  'Starbucks, Blue Bottle, and Philz should be categorized as "coffee" not "dining".',
  { tags: ['preference', 'categorization'], type: 'preference' }
)

// Later, search for categorization preferences before classifying
const prefs = await plexo.memory.search('categorization preference coffee', {
  limit: 5,
  type: 'preference',
})

// prefs[0].content → "User prefers to track coffee shop purchases separately..."
```

### 3c. Agent Invocation — Monthly Spending Summary

```typescript
// Invoke a Plexo agent to generate a spending summary
const task = await plexo.agents.invoke(
  `Generate a monthly spending summary for March 2026.
   Read the user's transaction history from memory namespace pax:vela.
   Group by category, show totals, and highlight any budget overages.
   Format as markdown.`,
  { type: 'report', priority: 'normal' }
)

// task.taskId is returned immediately — poll or subscribe for results
console.log(`Task queued: ${task.taskId}`)

// Poll for completion (or subscribe to task lifecycle events)
// The agent reads from pax:vela memory, processes, and returns a report
```

---

## 4. Error Response — Namespace Violation

If Vela attempts to read memory outside its declared namespace:

```typescript
// Vela's namespace is pax:vela — trying to read pax:fylo is forbidden
try {
  await plexo.memory.search('expense data', {
    // This internally targets pax:fylo namespace — not Vela's
  })
} catch (err) {
  // Server response:
  // {
  //   "error": {
  //     "code": "PAX_NS_VIOLATION",
  //     "message": "Memory operation targets namespace outside declaration",
  //     "detail": {
  //       "declared": "pax:vela",
  //       "attempted": "pax:fylo"
  //     }
  //   }
  // }
}
```

HTTP 403 with error code `PAX_NS_VIOLATION`. The host enforces namespace
boundaries regardless of what the token's capability claims contain.

---

## 5. MCP Tool Call — plexo_pax_status

From an MCP client (e.g., Claude Code connected to the Plexo MCP server):

```
Tool: plexo_pax_status
Input: { "app_name": "@vela/budget" }

Response:
{
  "appName": "@vela/budget",
  "version": "1.2.0",
  "capabilities": [
    "ai:complete",
    "memory:read:pax:vela",
    "memory:write:pax:vela",
    "memory:search:pax:vela",
    "events:subscribe:pax.fylo.expense_created",
    "agents:invoke"
  ],
  "manifestHash": "a3f8c2d1e4b5...",
  "issuedAt": "2026-03-29T14:30:00.000Z",
  "lastUsedAt": "2026-03-29T16:45:12.000Z",
  "tokenExpiresAt": "2026-06-27T14:30:00.000Z",
  "revoked": false,
  "revokedAt": null
}
```
