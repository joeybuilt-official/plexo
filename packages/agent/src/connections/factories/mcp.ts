// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP connection factory — discovers tools from a configured MCP server and
 * wraps each as an agent tool namespaced `mcp__<serverSlug>__<toolName>`.
 *
 * Reuses the transport logic in mcp/client.ts (connectMCP discovers + registers
 * the connection; callMCPTool invokes a tool on the registered connection).
 * Discovery is async, so this factory returns a Promise<ToolSet>; bridge.ts
 * awaits factory results. A missing/misconfigured server logs and returns an
 * empty set so the rest of the toolset still loads.
 */

import { tool } from 'ai'
import { z } from 'zod'
import pino from 'pino'

import { connectMCP, callMCPTool, type MCPServerConfig } from '../../mcp/client.js'
import type { ConnectionCredentials, ToolSet } from '../bridge-types.js'

const logger = pino({ name: 'mcp-factory' })

function sanitize(s: string): string {
    return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'unnamed'
}

function serverSlug(config: MCPServerConfig, connectionId: string): string {
    let raw = connectionId
    if (config.url) {
        try {
            raw = new URL(config.url).hostname
        } catch {
            raw = config.url
        }
    } else if (config.command) {
        raw = config.command.split('/').pop() ?? config.command
    }
    return sanitize(raw)
}

function normalizeArgs(args: unknown): string[] | undefined {
    if (args === undefined || args === null) return undefined
    if (Array.isArray(args)) return args as string[]
    if (typeof args === 'string') {
        return args.split(',').map((s) => s.trim()).filter(Boolean)
    }
    return undefined
}

export const MCP_TOOLS = async (
    creds: ConnectionCredentials,
    opts: { connectionId: string; workspaceId: string },
): Promise<ToolSet> => {
    const config: MCPServerConfig = {
        transport: (creds.transport as 'sse' | 'stdio') ?? 'sse',
        url: creds.url as string | undefined,
        command: creds.command as string | undefined,
        args: normalizeArgs(creds.args),
        apiKey: creds.api_key as string | undefined,
    }
    const slug = serverSlug(config, opts.connectionId)

    try {
        const discovered = await connectMCP(opts.connectionId, config)
        if (discovered.length === 0) {
            logger.info({ connectionId: opts.connectionId, slug }, 'MCP server connected but exposed no tools')
            return {}
        }
        const out: ToolSet = {}
        for (const t of discovered) {
            const name = `mcp__${slug}__${sanitize(t.name)}`
            out[name] = tool({
                description: t.description || `MCP tool ${t.name} from server ${slug}`,
                inputSchema: z.object({}).passthrough(),
                execute: async (args: Record<string, unknown>) => {
                    try {
                        return await callMCPTool(opts.connectionId, t.name, args)
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err)
                        return `MCP tool ${t.name} failed: ${msg}`
                    }
                },
            })
        }
        logger.info({ connectionId: opts.connectionId, slug, toolCount: discovered.length }, 'MCP tools loaded into agent toolset')
        return out
    } catch (err) {
        logger.warn(
            { err, connectionId: opts.connectionId, slug },
            'MCP tool discovery failed — connection contributes no tools (other connection tools still load)',
        )
        return {}
    }
}