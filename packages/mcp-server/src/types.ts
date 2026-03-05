/**
 * Shared types for the MCP server.
 *
 * SafeConnection: never exposes raw credentials over MCP transport.
 * The Drizzle query must explicitly select columns — never select *.
 */
import type { installedConnections } from '@plexo/db'

// The full row type from Drizzle
type InstalledConnectionRow = typeof installedConnections.$inferSelect

/**
 * SafeConnection omits the encrypted_credentials / credentials fields.
 * This is the only allowed return type for any tool querying installed_connections.
 */
export type SafeConnection = Omit<InstalledConnectionRow, 'credentials'>

/**
 * MCP request context — injected by auth middleware into every tool call.
 * The db property is intentionally absent here; tools receive it via the
 * workspace-scoped query helpers in context.ts.
 */
export interface McpContext {
    workspace_id: string
    token_id: string
    scopes: string[]
}

/**
 * Canonical scope list for MCP tokens.
 * connections:write does not exist — OAuth flows require browser redirects.
 */
export const MCP_SCOPES = [
    'tasks:read',
    'tasks:write',
    'connections:read',
    'memory:read',
    'memory:write',
    'sprints:write',
    'system:read',
    'events:read',
] as const

export type McpScope = (typeof MCP_SCOPES)[number]

/**
 * Token types. 'mcp' tokens are the only ones valid for MCP transport.
 */
export type TokenType = 'standard' | 'mcp'

/**
 * Shape of an MCP token record in the DB.
 */
export interface McpTokenRecord {
    id: string
    workspace_id: string
    name: string
    token_hash: string
    token_salt: string
    scopes: string[]
    type: TokenType
    revoked: boolean
    expires_at: Date | null
    last_used_at: Date | null
    created_at: Date
}

/**
 * Safe token representation for API responses (never includes hash/salt/raw value).
 */
export interface SafeMcpToken {
    id: string
    name: string
    scopes: string[]
    expires_at: Date | null
    last_used_at: Date | null
    revoked: boolean
    created_at: Date
}
