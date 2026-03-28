// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP Client — connects to Model Context Protocol servers and discovers tools.
 *
 * Supports two transports:
 * - SSE: connects to a remote MCP server via Server-Sent Events
 * - stdio: spawns a local process and communicates via stdin/stdout
 *
 * Tool discovery happens on connect. Discovered tools are registered
 * as connection-provided tools so the agent can invoke them.
 */

import pino from 'pino'

const logger = pino({ name: 'mcp-client' })

export interface MCPServerConfig {
    transport: 'sse' | 'stdio'
    url?: string          // For SSE transport
    command?: string      // For stdio transport
    args?: string[]       // For stdio transport
    apiKey?: string       // Optional auth header
}

export interface MCPTool {
    name: string
    description: string
    inputSchema: Record<string, unknown>
}

export interface MCPConnection {
    config: MCPServerConfig
    tools: MCPTool[]
    connected: boolean
}

// Active MCP connections keyed by connectionId
const activeConnections = new Map<string, MCPConnection>()

/**
 * Discover tools from an MCP server without maintaining a persistent connection.
 * Used during connection setup to validate the server and list available tools.
 */
export async function discoverMCPTools(config: MCPServerConfig): Promise<MCPTool[]> {
    if (config.transport === 'sse') {
        return discoverSSETools(config)
    } else if (config.transport === 'stdio') {
        return discoverStdioTools(config)
    }
    throw new Error(`Unsupported MCP transport: ${config.transport}`)
}

/**
 * Connect to an MCP server and register its tools.
 */
export async function connectMCP(connectionId: string, config: MCPServerConfig): Promise<MCPTool[]> {
    const tools = await discoverMCPTools(config)
    activeConnections.set(connectionId, { config, tools, connected: true })
    logger.info({ connectionId, toolCount: tools.length, transport: config.transport }, 'MCP server connected')
    return tools
}

/**
 * Disconnect an MCP server.
 */
export function disconnectMCP(connectionId: string): void {
    activeConnections.delete(connectionId)
    logger.info({ connectionId }, 'MCP server disconnected')
}

/**
 * Get tools from an active MCP connection.
 */
export function getMCPTools(connectionId: string): MCPTool[] {
    return activeConnections.get(connectionId)?.tools ?? []
}

/**
 * Get all active MCP connections.
 */
export function getAllMCPConnections(): Map<string, MCPConnection> {
    return activeConnections
}

/**
 * Call a tool on an MCP server.
 */
export async function callMCPTool(
    connectionId: string,
    toolName: string,
    args: Record<string, unknown>,
): Promise<unknown> {
    const conn = activeConnections.get(connectionId)
    if (!conn) throw new Error(`MCP connection ${connectionId} not found`)

    if (conn.config.transport === 'sse') {
        return callSSETool(conn.config, toolName, args)
    } else {
        return callStdioTool(conn.config, toolName, args)
    }
}

// ── SSE Transport ────────────────────────────────────────────────────────────

async function discoverSSETools(config: MCPServerConfig): Promise<MCPTool[]> {
    const { url, apiKey } = config
    if (!url) throw new Error('MCP SSE transport requires a url')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    // MCP protocol: POST to the server's endpoint with tools/list method
    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
        }),
        signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) throw new Error(`MCP server returned ${res.status}: ${await res.text().catch(() => '')}`)

    const data = await res.json() as { result?: { tools?: MCPTool[] }; error?: { message: string } }
    if (data.error) throw new Error(`MCP error: ${data.error.message}`)

    return (data.result?.tools ?? []).map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema ?? {},
    }))
}

async function callSSETool(
    config: MCPServerConfig,
    toolName: string,
    args: Record<string, unknown>,
): Promise<unknown> {
    const { url, apiKey } = config
    if (!url) throw new Error('MCP SSE transport requires a url')

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name: toolName, arguments: args },
        }),
        signal: AbortSignal.timeout(90_000),
    })

    if (!res.ok) throw new Error(`MCP tool call failed: ${res.status}`)
    const data = await res.json() as { result?: unknown; error?: { message: string } }
    if (data.error) throw new Error(`MCP tool error: ${data.error.message}`)
    return data.result
}

// ── stdio Transport ──────────────────────────────────────────────────────────

async function discoverStdioTools(config: MCPServerConfig): Promise<MCPTool[]> {
    const { command, args: cmdArgs } = config
    if (!command) throw new Error('MCP stdio transport requires a command')

    const { spawn } = await import('child_process')

    return new Promise((resolve, reject) => {
        const proc = spawn(command, cmdArgs ?? [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 15_000,
        })

        let stdout = ''
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
        proc.stderr.on('data', (d: Buffer) => { logger.warn({ stderr: d.toString() }, 'MCP stdio stderr') })

        // Send initialize + tools/list
        const initMsg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plexo', version: '1.0.0' } } }) + '\n'
        const listMsg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n'

        proc.stdin.write(initMsg)
        // Small delay to let the server process init before listing tools
        setTimeout(() => proc.stdin.write(listMsg), 500)

        const timer = setTimeout(() => {
            proc.kill()
            reject(new Error('MCP stdio discovery timed out after 15s'))
        }, 15_000)

        proc.on('close', () => {
            clearTimeout(timer)
            try {
                // Parse all JSON-RPC responses — find the tools/list response
                const lines = stdout.split('\n').filter(l => l.trim())
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line) as { id?: number; result?: { tools?: MCPTool[] } }
                        if (msg.id === 2 && msg.result?.tools) {
                            resolve(msg.result.tools.map(t => ({
                                name: t.name,
                                description: t.description ?? '',
                                inputSchema: t.inputSchema ?? {},
                            })))
                            return
                        }
                    } catch { /* skip non-JSON lines */ }
                }
                resolve([]) // No tools found
            } catch (err) {
                reject(err)
            }
        })

        proc.on('error', (err: Error) => {
            clearTimeout(timer)
            reject(new Error(`Failed to spawn MCP process "${command}": ${err.message}`))
        })
    })
}

async function callStdioTool(
    config: MCPServerConfig,
    toolName: string,
    args: Record<string, unknown>,
): Promise<unknown> {
    const { command, args: cmdArgs } = config
    if (!command) throw new Error('MCP stdio transport requires a command')

    const { spawn } = await import('child_process')

    return new Promise((resolve, reject) => {
        const proc = spawn(command, cmdArgs ?? [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 90_000,
        })

        let stdout = ''
        proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })

        // Send init + tool call
        const initMsg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plexo', version: '1.0.0' } } }) + '\n'
        const callMsg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }) + '\n'

        proc.stdin.write(initMsg)
        setTimeout(() => proc.stdin.write(callMsg), 300)

        const timer = setTimeout(() => {
            proc.kill()
            reject(new Error(`MCP tool call timed out after 90s`))
        }, 90_000)

        proc.on('close', () => {
            clearTimeout(timer)
            const lines = stdout.split('\n').filter(l => l.trim())
            for (const line of lines) {
                try {
                    const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } }
                    if (msg.id === 2) {
                        if (msg.error) reject(new Error(`MCP tool error: ${msg.error.message}`))
                        else resolve(msg.result)
                        return
                    }
                } catch { /* skip */ }
            }
            resolve(null)
        })

        proc.on('error', (err: Error) => {
            clearTimeout(timer)
            reject(err)
        })
    })
}
