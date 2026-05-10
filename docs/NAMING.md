# Plexo Naming Standard

Confirmed from codebase audit 2026-04-07. This is the canonical reference.

## Three Pillars (PEX v0.4.0)

| Pillar | What it is | Stored in |
|--------|-----------|-----------|
| **Connection** | Authenticated pipe to external service (inert, no logic) | `connections_registry` + `installed_connections` |
| **Extension** | Capability package — contains tools, prompts, schedules | `extensions` + `extension_registry` |
| **Agent** | Autonomous actor with goal, planning loop, identity | `extensions` table where `type = 'agent'` |

**Rule**: An Agent is NOT a subtype of Extension conceptually, even though both use the `extensions` table. An Extension does not think. An Agent does.

## Extension Type Enum (DB source of truth)

From `packages/db/src/schema.ts`:

```
agent | skill | channel | tool | connector | mcp-server | function
```

## User-Facing Label Mapping

| DB type | User-facing label | Where it appears |
|---------|------------------|-----------------|
| `skill` | **Skill** | Hub, installed list, SKILL.md files |
| `function` | **Tool** | Installed list, SDK registrations |
| `tool` | **Tool** | Legacy synonym for `function` |
| `channel` | **Channel** | Settings > Channels, messaging adapters |
| `connector` | **MCP Server** | Connections page |
| `mcp-server` | **MCP Server** | Connections page |
| `agent` | **Agent** | Agents page, separate from extensions |

## What the Sidebar Should Say

```
WORK
  Home
  New Chat
  Conversations

PLATFORM
  Agents          ← extensions where type = 'agent'
  Skills          ← extensions where type = 'skill' (was "Extensions")
  Tools           ← extensions where type = 'function' | 'tool' (was "Functions")
  Channels        ← channels table + extensions where type = 'channel'
  Hub     ← registry browse/install

SYSTEM
  Connections     ← installed_connections (auth pipes, not extensions)
  Settings        ← workspace config, AI providers, etc.
```

## What Changed from Pre-Standardization

| Old term | New term | Reason |
|----------|----------|--------|
| Extensions (nav item) | **Skills** | "Extension" is the abstract parent; "Skill" is the concrete type users install |
| Functions (nav item) | **Tools** | Aligns with Anthropic/OpenAI/LangChain "tool" vocabulary |
| Extensions (as catalog label) | **Skills** | SKILL.md is the standard format; skills are what users browse |

## What Does NOT Change

- DB enum values (`extensionTypeEnum`) — append only, never rename
- API route paths (`/api/v1/extensions`) — internal, not user-facing
- Analytics event names — historical continuity
- `extension_registry` / `extensions` table names — internal
- The word "Extension" in code (types, variables) — internal naming is fine

## Conflicts Found

1. **Sidebar says "Extensions"** but the standard term is "Skills" (type `skill` is the primary installable type)
2. **Sidebar says "Functions"** but the standard term is "Tools" (aligns with industry)
3. **Hub type badge** maps `skill` → "Extension" — should map to "Skill"
4. **Functions page** title says "Functions" — should say "Tools"
5. **Channels** appears under SYSTEM but is a PLATFORM concept (messaging adapters are capabilities, not settings)

No decision record conflicts found. The code's type system supports the standard; only display strings need updating.
