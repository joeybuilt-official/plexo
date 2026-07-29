// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory DB mock state — reset per test
let mockInstalledRows: any[] = []
let mockExtensionRows: any[] = []
let mockWorkspaceRows: any[] = []
let mockUpdateCalls: any[] = []

vi.mock('@plexo/db', async () => {
    // Build a db object that returns query results based on which table is
    // being queried. We inspect via from() to differentiate.
    const installedConnections = { __table: 'installed_connections' }
    const extensions = { __table: 'extensions' }
    const workspaces = { __table: 'workspaces' }
    const channels = { __table: 'channels' }

    const selectFrom = (table: any) => ({
        where: (_cond: unknown) => ({
            limit: async (_n: number) => {
                if (table === workspaces) return mockWorkspaceRows
                return []
            },
            // without limit, return matching rows
            then: undefined,
        }),
    })

    return {
        db: {
            select: vi.fn((_cols?: unknown) => ({
                from: (table: any) => {
                    const where = (_cond: unknown) => {
                        if (table === installedConnections) {
                            return Promise.resolve(mockInstalledRows)
                        }
                        if (table === extensions) {
                            return Promise.resolve(mockExtensionRows)
                        }
                        if (table === channels) {
                            return Promise.resolve([])
                        }
                        if (table === workspaces) {
                            return {
                                limit: async () => mockWorkspaceRows,
                            }
                        }
                        return Promise.resolve([])
                    }
                    return { where }
                },
            })),
            update: vi.fn((_table: any) => ({
                set: (vals: any) => ({
                    where: async (_cond: unknown) => {
                        mockUpdateCalls.push(vals)
                        return undefined
                    },
                }),
            })),
            execute: vi.fn(async () => [
                { total: '0', with_embedding: '0' },
            ]),
        },
        eq: vi.fn(() => ({})),
        and: vi.fn(() => ({})),
        sql: Object.assign(function sqlTag() { return {} }, { raw: () => ({}) }),
        installedConnections,
        extensions,
        workspaces,
        channels,
    }
})

vi.mock('../audit.js', async () => ({
    logAuditEntry: vi.fn(async () => undefined),
}))

// ── Tests ─────────────────────────────────────────────────────────────────────

async function loadBuilder() {
    const mod = await import('./self-knowledge-tools.js')
    return mod
}

describe('self-knowledge-tools', () => {
    beforeEach(() => {
        mockInstalledRows = []
        mockExtensionRows = []
        mockWorkspaceRows = []
        mockUpdateCalls = []
        vi.clearAllMocks()
    })

    describe('buildSelfKnowledgeTools', () => {
        it('returns the full set of self-knowledge tools', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            expect(Object.keys(tools)).toEqual(
                expect.arrayContaining([
                    'list_my_tools',
                    'get_my_capabilities',
                    'check_connection_status',
                    'about_plexo',
                    'toggle_connection_tool',
                ]),
            )
        })

        it('list_my_tools returns CORE block when empty workspace', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1', { includeExecutionTools: false })
            const result = await (tools.list_my_tools as any).execute(
                { category: 'all' },
                {} as any,
            )
            expect(result).toMatch(/CORE/)
            expect(result).toMatch(/CONNECTIONS: none installed/)
            expect(result).toMatch(/EXTENSIONS: none installed/)
        })

        it('list_my_tools includes execution tools when opted in', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1', { includeExecutionTools: true })
            const result = await (tools.list_my_tools as any).execute(
                { category: 'core' },
                {} as any,
            )
            expect(result).toMatch(/read_file/)
            expect(result).toMatch(/shell/)
            expect(result).toMatch(/write_asset/)
        })

        it('list_my_tools core category only shows core', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1', { includeExecutionTools: false })
            const result = await (tools.list_my_tools as any).execute(
                { category: 'core' },
                {} as any,
            )
            expect(result).toMatch(/CORE/)
            expect(result).not.toMatch(/CONNECTIONS/)
            expect(result).not.toMatch(/EXTENSIONS/)
        })

        it('list_my_tools renders connection rows when installed', async () => {
            mockInstalledRows = [
                {
                    id: 'c-1',
                    registryId: 'github',
                    name: 'Joeybuilt GH',
                    status: 'active',
                    enabledTools: null,
                },
            ]
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.list_my_tools as any).execute(
                { category: 'connections' },
                {} as any,
            )
            expect(result).toMatch(/GitHub/)
            expect(result).toMatch(/github__/)
        })
    })

    describe('check_connection_status', () => {
        it('returns NOT installed when provider is known but missing', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.check_connection_status as any).execute(
                { provider: 'github' },
                {} as any,
            )
            expect(result).toMatch(/GitHub/)
            expect(result).toMatch(/NOT installed/)
        })

        it('returns INSTALLED and tool list when provider is installed', async () => {
            mockInstalledRows = [
                {
                    id: 'c-gh',
                    registryId: 'github',
                    name: 'my-gh',
                    status: 'active',
                    enabledTools: null,
                },
            ]
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.check_connection_status as any).execute(
                { provider: 'github' },
                {} as any,
            )
            expect(result).toMatch(/INSTALLED/)
            expect(result).toMatch(/github__/)
        })

        it('returns unknown provider message for untracked provider', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.check_connection_status as any).execute(
                { provider: 'not-a-real-provider-xyz' },
                {} as any,
            )
            expect(result).toMatch(/not in the connection registry/)
        })

        it('lowercases provider lookup key', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.check_connection_status as any).execute(
                { provider: 'GITHUB' },
                {} as any,
            )
            expect(result).toMatch(/GitHub/)
        })
    })

    describe('about_plexo', () => {
        it('renders description with interpolated zero counts', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.about_plexo as any).execute({}, {} as any)
            expect(result).toMatch(/Plexo/)
            expect(result).toMatch(/0 configured providers/)
            expect(result).toMatch(/0 installed integrations/)
        })

        it('does not crash when DB reads fail silently', async () => {
            mockWorkspaceRows = []
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            await expect((tools.about_plexo as any).execute({}, {} as any))
                .resolves.toBeTruthy()
        })
    })

    describe('get_my_capabilities', () => {
        it('aggregates counts without throwing on empty workspace', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.get_my_capabilities as any).execute({}, {} as any)
            expect(result).toMatch(/LLM providers/)
            expect(result).toMatch(/Connections \(0\)/)
            expect(result).toMatch(/Memory:/)
        })

        it('reports LLM provider count and memory block', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.get_my_capabilities as any).execute({}, {} as any)
            expect(result).toMatch(/LLM providers/)
            expect(result).toMatch(/Channels configured/)
            expect(result).toMatch(/Memory:/)
        })
    })

    describe('toggle_connection_tool', () => {
        it('rejects unknown provider', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.toggle_connection_tool as any).execute(
                { provider: 'bogus-xyz', toolName: 'foo', enabled: true },
                {} as any,
            )
            expect(result).toMatch(/Unknown provider/)
        })

        it('errors when provider is known but not installed', async () => {
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.toggle_connection_tool as any).execute(
                { provider: 'github', toolName: 'create_issue', enabled: false },
                {} as any,
            )
            expect(result).toMatch(/is not installed/)
        })

        it('errors when neither toolName nor mode is provided', async () => {
            mockInstalledRows = [
                {
                    id: 'c-gh',
                    registryId: 'github',
                    name: 'gh',
                    status: 'active',
                    enabledTools: null,
                },
            ]
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.toggle_connection_tool as any).execute(
                { provider: 'github' },
                {} as any,
            )
            expect(result).toMatch(/Provide either/)
        })

        it('rejects unknown tool name for installed provider', async () => {
            mockInstalledRows = [
                {
                    id: 'c-gh',
                    registryId: 'github',
                    name: 'gh',
                    status: 'active',
                    enabledTools: null,
                },
            ]
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.toggle_connection_tool as any).execute(
                { provider: 'github', toolName: 'make_coffee', enabled: true },
                {} as any,
            )
            expect(result).toMatch(/not provided by GitHub/)
        })

        it('errors when toolName provided without enabled', async () => {
            mockInstalledRows = [
                {
                    id: 'c-gh',
                    registryId: 'github',
                    name: 'gh',
                    status: 'active',
                    enabledTools: null,
                },
            ]
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.toggle_connection_tool as any).execute(
                { provider: 'github', toolName: 'create_issue' },
                {} as any,
            )
            expect(result).toMatch(/Specify enabled=/)
        })

        it('read-only mode keeps read tools and drops write tools', async () => {
            mockInstalledRows = [
                {
                    id: 'c-gh',
                    registryId: 'github',
                    name: 'gh',
                    status: 'active',
                    enabledTools: null,
                },
            ]
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.toggle_connection_tool as any).execute(
                { provider: 'github', mode: 'read-only' },
                {} as any,
            )
            expect(result).toMatch(/read-only/)
            expect(mockUpdateCalls.length).toBeGreaterThan(0)
            const persisted = mockUpdateCalls[0]
            // should not contain any create_* / merge_* / push_* tools
            const enabledTools: string[] | null = persisted?.enabledTools
            expect(Array.isArray(enabledTools)).toBe(true)
            for (const t of enabledTools ?? []) {
                expect(t).not.toMatch(/create|merge|push/)
            }
        })

        it('mode=all sets enabledTools to null (every tool)', async () => {
            mockInstalledRows = [
                {
                    id: 'c-gh',
                    registryId: 'github',
                    name: 'gh',
                    status: 'active',
                    enabledTools: ['read_file'],
                },
            ]
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.toggle_connection_tool as any).execute(
                { provider: 'github', mode: 'all' },
                {} as any,
            )
            expect(result).toMatch(/all tools enabled/)
            expect(mockUpdateCalls[0]?.enabledTools).toBeNull()
        })

        it('single-tool toggle disable removes tool from set', async () => {
            mockInstalledRows = [
                {
                    id: 'c-gh',
                    registryId: 'github',
                    name: 'gh',
                    status: 'active',
                    enabledTools: null, // all enabled
                },
            ]
            const { buildSelfKnowledgeTools } = await loadBuilder()
            const tools = buildSelfKnowledgeTools('ws-1')
            const result = await (tools.toggle_connection_tool as any).execute(
                { provider: 'github', toolName: 'create_issue', enabled: false },
                {} as any,
            )
            expect(result).toMatch(/disabled/)
            const persisted: string[] | null = mockUpdateCalls[0]?.enabledTools
            if (persisted !== null) {
                expect(persisted).not.toContain('create_issue')
            }
        })
    })
})

describe('buildCompactCapabilitySummary', () => {
    beforeEach(() => {
        mockInstalledRows = []
        mockExtensionRows = []
        mockWorkspaceRows = []
        vi.clearAllMocks()
    })

    it('returns a static capability summary header', async () => {
        const { buildCompactCapabilitySummary } = await import('./self-knowledge-tools.js')
        const out = await buildCompactCapabilitySummary('ws-1')
        expect(out).toMatch(/CURRENT CAPABILITIES/)
        expect(out).toMatch(/list_my_tools/)
    })
})
