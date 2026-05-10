<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Pre-coding audit — written before any PAX code or spec work -->

# PAX Pre-Coding Audit

Audited: 2026-03-29
Scope: PEX SDK types, MCP server, CLI, API, DB schema

---

## 1. PEX SDK Types (packages/sdk/src/types/)

18 files total. Key structures for PAX precedent:

| File | Status | PAX Relevance |
|------|--------|---------------|
| manifest.ts | exists-and-good | Structural precedent for pax.json manifest. §-numbered comments, ExtensionSubtype, ManifestType, CapabilityToken type, EntityTypeName type. PAX manifests follow same structure. |
| trust.ts | exists-and-good | TrustTier type ('community' \| 'verified' \| 'owner'). PAX reuses community tier ceiling concept. |
| data-residency.ts | exists-and-good | DataResidencyDeclaration — PAX pax.json reuses same structure. |
| events.ts | exists-and-good | Event types, namespacing pattern. PAX events follow identical pattern. |
| entities.ts | exists-and-good | Entity type definitions. PAX entities:read/create tokens reference these. |
| channel.ts | exists-and-good | Channel types — not directly relevant to PAX. |
| a2a.ts | exists-and-good | Agent-to-agent protocol — distinct from PAX (app-to-Plexo). |
| sdk.ts | exists-and-good | SDK surface type definitions — PAX SDK surface mirrors this. |
| escalation.ts | exists-and-good | Escalation declarations — PAX inherits if agents involved. |
| model-context.ts | exists-and-good | Model requirements — PAX ai:complete uses these. |

**Capability token format**: `surface:action:scope` (e.g., `memory:read:person`).
PAX tokens follow this exact format.

## 2. MCP Server (packages/mcp-server/src/)

### index.ts — Server Factory
- **Pattern**: `createMcpServer(ctx)` creates per-request McpServer instance
- **Context**: `WeakMap<McpServer, McpContext | null>` stores auth context
- **Tool registration**: `server.tool(name, description, inputSchema.shape, handler)`
- **Auth check in handler**: `const resolvedCtx = getCtx(server); if (!resolvedCtx) return unauthorized`
- **Return shape**: `{ content: [{ type: 'text', text: JSON.stringify(result) }], isError: boolean }`
- **Status**: exists-and-good. PAX tools follow identical pattern.

### auth.ts — Token Validation
- `validateMcpToken(authHeader)` → `AuthResult | AuthFailure`
- Token format: `plx_` + 32 random bytes base64url
- Hash: SHA-256(raw + salt), scans all non-revoked tokens of type 'mcp'
- Rate limit: 60 req/min per token via Redis
- `requireScope(ctx, scope)` — scope gate for tools
- `generateToken()` → `{ rawToken, hash, salt }`
- `hashToken(rawToken, salt)` → hex string
- **Status**: exists-and-good. PAX reuses `generateToken()` and `hashToken()`. PAX tokens stored in same `mcp_tokens` table with type='pax'.

### types.ts — McpContext
- `McpContext { workspace_id, token_id, scopes: string[] }`
- `MCP_SCOPES` const array: tasks:read, tasks:write, connections:read, memory:read, memory:write, sprints:write, system:read, events:read
- **Status**: needs-extension. Add `pax:read` and `pax:manage` to MCP_SCOPES.

### errors.ts — Error Helpers
- `McpErrorCode` union type, `McpErrorResponse { error, code, correlation_id }`
- Helpers: `mcpError()`, `internalError()`, `scopeDenied()`, `notFound()`
- **Status**: exists-and-good. PAX MCP tools use same helpers.

### tools/tasks.ts — Task Tools (pattern reference)
- Exports: `listTasksInputSchema`, `createTaskInputSchema`, `plexoListTasks`, `plexoCreateTask`, etc.
- Each handler: `(input, ctx) => Promise<unknown>`
- Scope check first: `if (!requireScope(ctx, 'tasks:read')) return scopeDenied('tasks:read')`
- DB queries use raw SQL via `db.execute(sql\`...\`)`
- **Status**: exists-and-good. PAX tools follow identical pattern.

### tools/memory.ts — Memory Tools (pattern reference)
- `searchMemoryInputSchema = z.object({...}).strict()`
- Handler returns `{ results, total, note }` or error
- Logger: `logger.info({ event: 'mcp_tool_call', tool_name: '...', token_id: ctx.token_id })`
- **Status**: exists-and-good.

### resources/index.ts, prompts/index.ts
- Resource and prompt definitions — not relevant to PAX tools.

## 3. CLI (apps/cli/src/)

### index.ts — Command Registration
- Pattern: `import { registerXxx } from './commands/xxx.js'` then `registerXxx(program)`
- 10 command groups registered: auth, task, sprint, cron, connection, extension, memory, logs, status, config
- **Status**: needs-extension. Add `registerPax(program)`.

### Config/Auth Pattern (config.ts)
- `PlexoProfile { host, token, userId, workspace }`
- `requireProfile(opts.profile)` — returns profile or exits with code 4
- Env vars override: PLEXO_HOST, PLEXO_TOKEN, PLEXO_USER_ID, PLEXO_WORKSPACE
- **Status**: exists-and-good. PAX commands use same pattern.

### Client (client.ts)
- `buildClient(profile)` → `{ get, post, patch, delete }`
- Sends: content-type, x-user-id, x-workspace-id, authorization headers
- `ApiError { status, code, message }` on non-2xx
- **Status**: exists-and-good. PAX commands use same client.

### Output (output.ts)
- `output(format, head, rows, rowFn)` — table/json/csv
- `spinner(text)` → `{ success, error, stop }`
- `c` — chalk wrapper (dim, bold, green, yellow, red, cyan, blue, magenta, gray)
- `statusBadge(status)` — color-coded status string
- `fatal(err, exitCode)` — stderr + exit
- **Status**: exists-and-good. PAX commands use same utilities.

### commands/connection.ts (pattern reference)
- `registerConnection(program)` exports function
- `program.command('connection').description('...')`
- Subcommands: list, get, install, remove, test
- All use: `requireProfile(opts.profile)`, `buildClient(profile)`, `output()`, `spinner()`
- **Status**: exists-and-good. PAX commands follow identical pattern.

## 4. API (apps/api/src/)

### index.ts — Router Mounting
- `const v1 = express.Router()`
- Routes mounted: `v1.use('/path', [middleware...], router)`
- Mounted at: `app.use('/api/v1', v1)` and `app.use('/api', v1)`
- **Status**: needs-extension. Add `v1.use('/pax', paxRouter)`.

### routes/connections.ts (pattern reference)
- `const router = express.Router()`
- Endpoints: GET/POST/PATCH/PUT/DELETE
- Auth: reads `x-workspace-id` header, validates UUID format
- Error shape: `{ error: { code: 'SOME_CODE', message: 'Human-readable' } }`
- Success shape: `{ ok: true }` or `{ id, message }` or `{ items, total }`
- UUID validation: `UUID_RE` regex from `../validation.js`
- **Status**: exists-and-good. PAX router follows identical pattern.

### Auth Middleware
- `requireSupabaseAuth` — validates Supabase JWT, attaches `req.user`
- `requireServiceKey` — validates PLEXO_SERVICE_KEY via Bearer
- `cmdCenterAuth` — accepts either JWT or service key
- **Status**: exists-and-good. PAX uses service key auth for registration (workspace-level ops).

## 5. DB Schema (packages/db/src/schema.ts)

### mcpTokens Table
```
mcp_tokens:
  id             uuid PK defaultRandom
  workspace_id   uuid FK → workspaces.id CASCADE
  name           text NOT NULL
  token_hash     text NOT NULL
  token_salt     text NOT NULL
  scopes         text[] NOT NULL DEFAULT '{}'
  type           text NOT NULL DEFAULT 'mcp'
  revoked        boolean NOT NULL DEFAULT false
  expires_at     timestamp
  last_used_at   timestamp
  created_at     timestamp DEFAULT now() NOT NULL
```
- **Status**: exists-and-good. PAX tokens reuse this table with type='pax'. No new token table needed.

### Conventions
- PKs: `uuid('id').defaultRandom().primaryKey()`
- FKs: `.references(() => table.id, { onDelete: 'cascade' })`
- Timestamps: `timestamp('col', { mode: 'date' }).defaultNow().notNull()`
- Text arrays: `text('col').array().notNull().default(sql\`'{}'\`)`
- Indexes: array-return style `(table) => [index(...), ...]`
- **Status**: exists-and-good. New `pax_registrations` table follows same conventions.

### Migration
- Format: `NNNN_descriptive_name.sql` (zero-padded 4-digit)
- Latest: `0033_reflection_index.sql`
- **Next**: `0034_pax_registrations.sql`

## 6. Summary Classification

| Component | Classification | Action |
|-----------|---------------|--------|
| PEX SDK types | exists-and-good | Use as precedent for spec tone/structure |
| MCP auth (generateToken, hashToken) | exists-and-good | Reuse directly — no duplication |
| MCP types (McpContext, MCP_SCOPES) | needs-extension | Add pax:read, pax:manage scopes |
| MCP index.ts (tool registration) | needs-extension | Add PAX tool imports + registration |
| MCP errors | exists-and-good | Use as-is |
| CLI index.ts (command registration) | needs-extension | Add registerPax import + call |
| CLI config/client/output | exists-and-good | Use as-is |
| API index.ts (router mounting) | needs-extension | Add pax router import + mount |
| API auth middleware | exists-and-good | Reuse requireServiceKey for workspace ops |
| DB schema (mcp_tokens) | exists-and-good | PAX tokens stored here with type='pax' |
| DB schema (pax_registrations) | missing | New table needed |
| DB migration 0034 | missing | New migration file |
| docs/pax/ | missing | All spec docs to be created |
