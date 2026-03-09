// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo MCP Server — Phase 1 entrypoint
 *
 * Transport selection via MCP_TRANSPORT env var:
 *   http  = Streamable HTTP on MCP_PORT (default 3002), using Node.js http module
 *   stdio = stdin/stdout for Claude Code / local dev
 *
 * Started as a sidecar from apps/api/src/index.ts when MCP_ENABLED=true.
 * Can also run standalone: MCP_TRANSPORT=stdio node packages/mcp-server/dist/index.js
 *
 * Context injection pattern:
 *   HTTP transport: per-request McpServer instance, ctx stored on server._ctx.
 *   The tool handlers read ctx from server._ctx via a module-level WeakMap.
 *   Stdio transport: single auth at startup, ctx stored globally.
 */
import { config as dotenvConfig } from 'dotenv'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const __dir = dirname(fileURLToPath(import.meta.url))
const monorepoRoot = resolve(__dir, '../../../')
dotenvConfig({ path: resolve(monorepoRoot, '.env'), override: false })
dotenvConfig({ path: resolve(monorepoRoot, '.env.local'), override: true })

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { logger } from './logger.js'
import { validateMcpToken } from './auth.js'
import {
    healthInputSchema,
    workspaceInfoInputSchema,
    plexoHealth,
    plexoWorkspaceInfo,
} from './tools/system.js'
import type { McpContext } from './types.js'

// ── Per-server context registry ───────────────────────────────────────────────
// WeakMap keyed by McpServer instance; maps to the auth context for that request.
// This is how we pass per-request context through the MCP SDK tool handler.
const serverCtx = new WeakMap<McpServer, McpContext | null>()

function getCtx(server: McpServer): McpContext | null {
    return serverCtx.get(server) ?? null
}

// ── Server factory ────────────────────────────────────────────────────────────

function createMcpServer(ctx: McpContext | null): McpServer {
    const server = new McpServer({
        name: 'plexo',
        version: '0.1.0',
    })

    // Store context for this server instance
    serverCtx.set(server, ctx)

    // ── plexo_health — no auth required ─────────────────────────────────────
    server.tool(
        'plexo_health',
        'Check Plexo system health. No authentication required. Use for uptime monitoring.',
        healthInputSchema.shape,
        async (input) => {
            const result = await plexoHealth(input as z.infer<typeof healthInputSchema>)
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                isError: false,
            }
        },
    )

    // ── plexo_workspace_info — requires system:read ──────────────────────────
    server.tool(
        'plexo_workspace_info',
        'Get workspace metadata: agent status, active tasks, cost usage, connections. Requires system:read scope.',
        workspaceInfoInputSchema.shape,
        async (input) => {
            const resolvedCtx = getCtx(server)
            if (!resolvedCtx) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED', correlation_id: crypto.randomUUID() }) }],
                    isError: true,
                }
            }
            const result = await plexoWorkspaceInfo(
                input as z.infer<typeof workspaceInfoInputSchema>,
                resolvedCtx,
            )
            const asObj = result as Record<string, unknown>
            const isError = 'error' in asObj
            return {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                isError,
            }
        },
    )

    return server
}

// ── HTTP Transport ────────────────────────────────────────────────────────────

async function startHttpServer(): Promise<void> {
    const port = parseInt(process.env.MCP_PORT ?? '3002', 10)

    // Map of session ID to active transport (for stateful sessions)
    const transports = new Map<string, StreamableHTTPServerTransport>()

    const httpServer = http.createServer(async (req, res) => {
        if (!req.url?.startsWith('/mcp')) {
            res.writeHead(404).end()
            return
        }

        const startMs = Date.now()

        // Read request body
        let body: string = ''
        for await (const chunk of req) {
            body += chunk
        }

        let parsedBody: unknown = undefined
        if (body) {
            try {
                parsedBody = JSON.parse(body)
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'Invalid JSON' }))
                return
            }
        }

        // Authenticate — null ctx is OK for plexo_health
        const authHeader = req.headers['authorization']
        const authResult = await validateMcpToken(authHeader)

        let ctx: McpContext | null = null
        if (authResult.ok) {
            ctx = authResult.ctx
        } else if (authResult.status === 429) {
            res.writeHead(429, {
                'Content-Type': 'application/json',
                'Retry-After': String(authResult.retryAfter ?? 60),
            })
            res.end(JSON.stringify({ error: 'Rate limit exceeded', code: 'RATE_LIMITED' }))
            return
        }
        // For non-auth errors, ctx stays null — tools will handle unauthorized access

        // Create per-request server with context
        const server = createMcpServer(ctx)
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
        })

        transport.onclose = () => {
            // Cleanup if needed
            serverCtx.delete(server)
        }

        await server.connect(transport)
        await transport.handleRequest(req, res, parsedBody)

        const duration = Date.now() - startMs
        if (ctx) {
            logger.info({
                event: 'mcp_request',
                token_id: ctx.token_id,
                workspace_id: ctx.workspace_id,
                duration_ms: duration,
                path: req.url,
            }, 'MCP request handled')
        }
    })

    httpServer.listen(port, '0.0.0.0', () => {
        logger.info({ port }, 'Plexo MCP HTTP server started')
    })

    httpServer.on('error', (err) => {
        logger.fatal({ err }, 'MCP HTTP server error')
        process.exit(1)
    })
}

// ── Stdio Transport ───────────────────────────────────────────────────────────

async function startStdioServer(): Promise<void> {
    const token = process.env.PLEXO_MCP_TOKEN
    if (!token) {
        logger.error('MCP_TRANSPORT=stdio requires PLEXO_MCP_TOKEN env var')
        process.exit(1)
    }

    const authResult = await validateMcpToken(`Bearer ${token}`)
    if (!authResult.ok) {
        logger.error({ code: authResult.status, message: authResult.message }, 'MCP stdio auth failed')
        process.exit(1)
    }

    const ctx = authResult.ctx
    const server = createMcpServer(ctx)
    const transport = new StdioServerTransport()
    await server.connect(transport)
    logger.info({ token_id: ctx.token_id, workspace_id: ctx.workspace_id }, 'MCP stdio server started')
}

// ── Entry point ───────────────────────────────────────────────────────────────

const mcpTransport = process.env.MCP_TRANSPORT ?? 'http'

if (mcpTransport === 'stdio' || process.argv.includes('--transport=stdio')) {
    startStdioServer().catch((err) => {
        logger.fatal({ err }, 'MCP stdio server failed to start')
        process.exit(1)
    })
} else {
    startHttpServer().catch((err) => {
        logger.fatal({ err }, 'MCP HTTP server failed to start')
        process.exit(1)
    })
}

export { createMcpServer }
