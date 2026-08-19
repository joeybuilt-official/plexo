// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP bridge integration — verifies loadConnectionTools pulls MCP-discovered
 * tools into the runtime toolset when an mcp_custom connection is installed,
 * and degrades gracefully when discovery throws.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────────────

const mcpCreds = { transport: 'sse', url: 'http://mcp.local:3000', api_key: 'secret' }

const connectMCPMock = vi.fn()
const callMCPToolMock = vi.fn()

vi.mock('../mcp/client.js', () => ({
    connectMCP: (...args: unknown[]) => connectMCPMock(...args),
    callMCPTool: (...args: unknown[]) => callMCPToolMock(...args),
    discoverMCPTools: vi.fn(),
}))

vi.mock('./crypto-util.js', () => ({
    decrypt: vi.fn(() => JSON.stringify(mcpCreds)),
    encrypt: vi.fn(() => 'enc'),
}))

vi.mock('../profile/grant.js', () => ({
    resolveEnforcedProfile: vi.fn().mockResolvedValue(null),
    getEnforcementMode: vi.fn().mockReturnValue('off'),
}))

vi.mock('../profile/resolve.js', () => ({
    isConnectorAllowed: vi.fn().mockReturnValue(true),
}))

vi.mock('../profile/monitor.js', () => ({
    recordMonitorObservations: vi.fn().mockResolvedValue(undefined),
}))

// DB mock — one active mcp_custom row.
const rows = [{
    id: 'conn-mcp-1',
    registryId: 'mcp_custom',
    credentials: { encrypted: 'enc' },
    enabledTools: null,
    status: 'active',
}]

vi.mock('@plexo/db', () => {
    const installedConnections = {
        id: 'id', registryId: 'registry_id', credentials: 'credentials',
        enabledTools: 'enabled_tools', status: 'status', workspaceId: 'workspace_id',
    }
    const workspaces = { id: 'id', settings: 'settings' }
    const extensions = { name: 'name', enabled: 'enabled', workspaceId: 'workspace_id' }
    const selectFor = (table: unknown) => {
        if (table === workspaces) return Promise.resolve([{ settings: {} }])
        if (table === extensions) return Promise.resolve([])
        return Promise.resolve(rows)
    }
    return {
        db: {
            select: vi.fn(() => ({
                from: vi.fn((table: unknown) => ({
                    where: vi.fn(() => selectFor(table)),
                    limit: vi.fn(() => selectFor(table)),
                })),
            })),
            update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
        },
        eq: vi.fn(),
        and: vi.fn(),
        inArray: vi.fn(),
        installedConnections,
        workspaces,
        extensions,
    }
})

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
    connectMCPMock.mockReset()
    callMCPToolMock.mockReset()
})

const { loadConnectionTools } = await import('./bridge.js')

describe('loadConnectionTools — MCP integration', () => {
    it('includes namespaced MCP tools when an MCP connection is configured', async () => {
        connectMCPMock.mockResolvedValue([
            { name: 'search_docs', description: 'Search docs', inputSchema: {} },
            { name: 'fetch_page', description: 'Fetch a page', inputSchema: {} },
        ])
        callMCPToolMock.mockResolvedValue('ok')

        const tools = await loadConnectionTools('ws-1')

        const names = Object.keys(tools)
        expect(names.filter((n) => n.startsWith('mcp__'))).toHaveLength(2)
        // serverSlug derived from url hostname `mcp.local`
        expect(tools).toHaveProperty('mcp__mcp_local__search_docs')
        expect(tools).toHaveProperty('mcp__mcp_local__fetch_page')

        // execute routes to callMCPTool with the raw MCP tool name + args
        const result = await tools['mcp__mcp_local__search_docs'].execute({ query: 'x' })
        expect(callMCPToolMock).toHaveBeenCalledWith('conn-mcp-1', 'search_docs', { query: 'x' })
        expect(result).toBe('ok')
    })

    it('degrades gracefully when MCP discovery throws (no tools, no crash)', async () => {
        connectMCPMock.mockRejectedValue(new Error('connection refused'))

        const tools = await loadConnectionTools('ws-1')

        const mcpNames = Object.keys(tools).filter((n) => n.startsWith('mcp__'))
        expect(mcpNames).toHaveLength(0)
        // synthesize_extension still present — MCP failure didn't crash the toolset
        expect(tools).toHaveProperty('synthesize_extension')
    })

    it('contributes no tools when MCP server exposes zero tools', async () => {
        connectMCPMock.mockResolvedValue([])

        const tools = await loadConnectionTools('ws-1')
        expect(Object.keys(tools).filter((n) => n.startsWith('mcp__'))).toHaveLength(0)
    })
})