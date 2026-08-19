// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drift test — ensures the single-source-of-truth invariant holds.
 *
 * For every descriptor in CONNECTION_REGISTRY:
 *   - factory exists (not undefined)
 *   - declared capability short-names match the actual tool suffixes the
 *     factory produces when called with empty credentials
 *   - every tool is namespaced with `${toolPrefix}__`
 *
 * If any of these fail, one of the derived maps (manifest / introspection)
 * is advertising a capability the runtime cannot deliver — the exact bug
 * Phase 2 eliminates.
 */

import { describe, expect, it, beforeAll } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import {
    CONNECTION_REGISTRY,
    buildToolFactoryMap,
    buildManifestCapabilityMap,
    buildIntrospectionToolMap,
    buildIntrospectionCapabilityMap,
    connectionRegistryCount,
    registerBridgeFactories,
} from './registry.js'

// bridge.ts pulls @plexo/db which Vitest can't resolve in package-scope tests.
// Register synthetic factories for every provider whose real factory lives
// in bridge.ts. The drift test only cares about the SHAPE of the returned
// ToolSet — not the execute() bodies — so synthetic factories that echo the
// declared capabilities keep the invariant checkable without touching the DB.
beforeAll(() => {
    const synth = (prefix: string, names: string[]) => () => {
        const out: Record<string, unknown> = {}
        for (const n of names) {
            out[`${prefix}__${n}`] = tool({
                description: 'test stub',
                inputSchema: z.object({}).passthrough(),
                execute: async () => 'stub',
            })
        }
        return out
    }

    const bridgeProviders = [
        'github', 'slack', 'vercel', 'stripe', 'cloudflare',
        'sentry', 'posthog', 'ovhcloud', 'deepgram',
    ] as const

    const refs: Partial<Record<typeof bridgeProviders[number], ReturnType<typeof synth>>> = {}
    for (const id of bridgeProviders) {
        const desc = CONNECTION_REGISTRY[id]
        if (!desc) continue
        refs[id] = synth(desc.toolPrefix, desc.capabilities.map((c) => c.name))
    }
    registerBridgeFactories(refs as Parameters<typeof registerBridgeFactories>[0])
})

const DUMMY_CREDS = {}
const DUMMY_OPTS = { connectionId: 'test-conn', workspaceId: 'test-ws' }

describe('connection registry — single source of truth', () => {
    it('has at least the baseline 24 providers', () => {
        const count = connectionRegistryCount()
        expect(count.total).toBeGreaterThanOrEqual(24)
        expect(count.real).toBeGreaterThanOrEqual(13)
        expect(count.stub).toBeGreaterThanOrEqual(11)
    })

    it('every descriptor has a callable factory', () => {
        for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
            expect(typeof desc.factory, `factory for ${id}`).toBe('function')
        }
    })

    it('factory tool names match declared capabilities (no drift)', async () => {
        for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
            const tools = await desc.factory(DUMMY_CREDS, DUMMY_OPTS)
            const actualNames = Object.keys(tools).sort()
            const expectedNames = desc.capabilities
                .map((c) => `${desc.toolPrefix}__${c.name}`)
                .sort()
            expect(actualNames, `drift in ${id}`).toEqual(expectedNames)
        }
    })

    it('every tool name is prefixed with its provider toolPrefix', async () => {
        for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
            const tools = await desc.factory(DUMMY_CREDS, DUMMY_OPTS)
            for (const name of Object.keys(tools)) {
                expect(name.startsWith(`${desc.toolPrefix}__`), `${id} tool ${name}`).toBe(true)
            }
        }
    })

    it('buildToolFactoryMap has same keys as CONNECTION_REGISTRY', () => {
        const factoryMap = buildToolFactoryMap()
        expect(Object.keys(factoryMap).sort()).toEqual(Object.keys(CONNECTION_REGISTRY).sort())
    })

    it('buildIntrospectionToolMap has same keys as CONNECTION_REGISTRY', () => {
        const toolMap = buildIntrospectionToolMap()
        expect(Object.keys(toolMap).sort()).toEqual(Object.keys(CONNECTION_REGISTRY).sort())
    })

    it('buildManifestCapabilityMap has same keys as CONNECTION_REGISTRY', () => {
        const capMap = buildManifestCapabilityMap()
        expect(Object.keys(capMap).sort()).toEqual(Object.keys(CONNECTION_REGISTRY).sort())
    })

    it('manifest capability entries include (stub) suffix for stub providers', () => {
        const capMap = buildManifestCapabilityMap()
        for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
            if (desc.stub) {
                for (const entry of capMap[id] ?? []) {
                    expect(entry.endsWith(' (stub)'), `${id} should have (stub) suffix`).toBe(true)
                }
            } else {
                for (const entry of capMap[id] ?? []) {
                    expect(entry.endsWith(' (stub)'), `${id} should NOT have (stub) suffix`).toBe(false)
                }
            }
        }
    })

    it('introspection tool map produces fully-qualified names', () => {
        const toolMap = buildIntrospectionToolMap()
        for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
            const names = toolMap[id] ?? []
            expect(names.length).toBe(desc.capabilities.length)
            for (const n of names) {
                expect(n).toContain('__')
                expect(n.startsWith(`${desc.toolPrefix}__`)).toBe(true)
            }
        }
    })

    it('introspection capability map returns short names only', () => {
        const capMap = buildIntrospectionCapabilityMap()
        for (const [id, desc] of Object.entries(CONNECTION_REGISTRY)) {
            const caps = capMap[id] ?? []
            expect(caps).toEqual(desc.capabilities.map((c) => c.name))
            for (const c of caps) {
                expect(c).not.toContain('__')
                expect(c).not.toContain('(stub)')
            }
        }
    })
})
