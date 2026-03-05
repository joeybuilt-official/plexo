/**
 * Standardized MCP error helpers.
 *
 * All errors returned from tools follow this shape:
 *   { error: string, code: string, correlation_id: string }
 *
 * Real error details are logged server-side with the correlation_id.
 * Never expose stack traces, DB errors, or credential values in MCP responses.
 */
import { randomUUID } from 'node:crypto'

export type McpErrorCode =
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'INVALID_INPUT'
    | 'RATE_LIMITED'
    | 'INTERNAL'
    | 'SCOPE_DENIED'
    | 'TOKEN_EXPIRED'
    | 'TOKEN_REVOKED'
    | 'WORKSPACE_NOT_FOUND'

export interface McpErrorResponse {
    error: string
    code: McpErrorCode
    correlation_id: string
}

export function mcpError(message: string, code: McpErrorCode, correlationId?: string): McpErrorResponse {
    return {
        error: message,
        code,
        correlation_id: correlationId ?? randomUUID(),
    }
}

export function internalError(correlationId?: string): McpErrorResponse {
    return mcpError('Internal error', 'INTERNAL', correlationId)
}

export function scopeDenied(required: string): McpErrorResponse {
    return mcpError(`Scope required: ${required}`, 'SCOPE_DENIED')
}

export function notFound(resource: string): McpErrorResponse {
    return mcpError(`${resource} not found`, 'NOT_FOUND')
}
