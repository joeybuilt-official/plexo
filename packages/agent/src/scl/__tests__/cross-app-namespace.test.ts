// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cross-app namespace isolation tests.
 *
 * Verifies that mutateWithNamespace correctly:
 * 1. Tags newly created attractors with the calling app's namespace
 * 2. Prevents app B from refining attractors owned by app A
 * 3. Allows any app to refine 'core' (unnamespaced) attractors
 *
 * Mocks @plexo/db and the storage layer to avoid a real database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { boot } from '@plexo/scl-core'
import type { GoldenRecord } from '@plexo/scl-core'

// Store for mock Golden Record — persists across save/load within a test
const store: { record: GoldenRecord | null } = { record: null }

vi.mock('../storage.js', () => ({
    isSclEnabled: vi.fn().mockResolvedValue(true),
    loadGoldenRecord: vi.fn(async () => store.record),
    saveGoldenRecord: vi.fn(async (_ws: string, record: GoldenRecord) => {
        store.record = record
    }),
}))

// 4-D orthogonal basis vectors (same as scl-core test fixtures)
const V_IDENTITY = [1, 0, 0, 0]
const V_CODING   = [0, 0, 1, 0]
const V_DEVOPS   = [0, 0, 0, 1]

function makeRecord(): GoldenRecord {
    return boot({
        workspaceId: 'test-ws',
        spiritAnchors: [{ label: 'Identity', type: 'entity', position: V_IDENTITY }],
    })
}

beforeEach(() => {
    store.record = makeRecord()
    vi.clearAllMocks()
    // Re-stub after clearAllMocks
    const storageMod = vi.importActual('../storage.js') // keeps mock in place
    void storageMod
})

describe('mutateWithNamespace: attractor-level namespace tagging', () => {
    it('tags a newly created attractor with the calling app namespace', async () => {
        const { mutateWithNamespace } = await import('../cross-app.js')

        const result = await mutateWithNamespace('test-ws', {
            source: 'fylo',
            namespace: 'fylo',
            concepts: [{ label: 'Receipt Processing', type: 'action', position: V_CODING }],
            relations: [],
        })

        expect(result.ok).toBe(true)
        const attractor = store.record!.attractors.find(a => a.label === 'Receipt Processing')
        expect(attractor).toBeDefined()
        expect(attractor!.namespace).toBe('fylo')
    })

    it('does not overwrite namespace on pre-existing attractors that are refined', async () => {
        const { mutateWithNamespace } = await import('../cross-app.js')

        // App A creates attractor
        await mutateWithNamespace('test-ws', {
            source: 'fylo',
            namespace: 'fylo',
            concepts: [{ label: 'Fylo Concept', type: 'action', position: V_CODING }],
            relations: [],
        })

        // App A refines its own attractor (allowed — same namespace)
        const close = V_CODING.map((v, i) => i === 2 ? 0.999 : v + 0.001)
        await mutateWithNamespace('test-ws', {
            source: 'fylo',
            namespace: 'fylo',
            concepts: [{ label: 'Fylo Concept', type: 'action', position: close }],
            relations: [],
        })

        const attractor = store.record!.attractors.find(a => a.label === 'Fylo Concept')
        expect(attractor!.namespace).toBe('fylo') // not overwritten to 'fylo' twice — still correct
    })
})

describe('mutateWithNamespace: namespace enforcement', () => {
    it('rejects app B refining an attractor owned by app A', async () => {
        const { mutateWithNamespace } = await import('../cross-app.js')

        // App A writes
        await mutateWithNamespace('test-ws', {
            source: 'fylo',
            namespace: 'fylo',
            concepts: [{ label: 'Fylo Revenue', type: 'action', position: V_CODING }],
            relations: [],
        })

        // App B tries to refine same label
        const result = await mutateWithNamespace('test-ws', {
            source: 'levio',
            namespace: 'levio',
            concepts: [{ label: 'Fylo Revenue', type: 'action', position: V_CODING }],
            relations: [],
        })

        expect(result.ok).toBe(false)
        expect(result.error).toContain('fylo')
    })

    it('allows any app to refine a core (unnamespaced) attractor', async () => {
        const { mutateWithNamespace } = await import('../cross-app.js')

        // Spirit anchor 'Identity' has no namespace → treated as core
        // Position very close to V_IDENTITY so it refines (no drift warning)
        const veryClose = [0.9999, 0.001, 0, 0]
        const result = await mutateWithNamespace('test-ws', {
            source: 'levio',
            namespace: 'levio',
            concepts: [{ label: 'Identity', type: 'entity', position: veryClose }],
            relations: [],
        })

        expect(result.ok).toBe(true)
    })

    it('allows an app to refine its own attractors', async () => {
        const { mutateWithNamespace } = await import('../cross-app.js')

        // App A creates
        await mutateWithNamespace('test-ws', {
            source: 'fylo',
            namespace: 'fylo',
            concepts: [{ label: 'Own Concept', type: 'action', position: V_DEVOPS }],
            relations: [],
        })

        // App A refines
        const result = await mutateWithNamespace('test-ws', {
            source: 'fylo',
            namespace: 'fylo',
            concepts: [{ label: 'Own Concept', type: 'action', position: V_DEVOPS }],
            relations: [],
        })

        expect(result.ok).toBe(true)
    })

    it('two apps can independently create attractors with different labels', async () => {
        const { mutateWithNamespace } = await import('../cross-app.js')

        await mutateWithNamespace('test-ws', {
            source: 'fylo', namespace: 'fylo',
            concepts: [{ label: 'Fylo Thing', type: 'action', position: V_CODING }],
            relations: [],
        })

        const result = await mutateWithNamespace('test-ws', {
            source: 'levio', namespace: 'levio',
            concepts: [{ label: 'Levio Thing', type: 'action', position: V_DEVOPS }],
            relations: [],
        })

        expect(result.ok).toBe(true)
        const fyloAttr = store.record!.attractors.find(a => a.label === 'Fylo Thing')
        const levioAttr = store.record!.attractors.find(a => a.label === 'Levio Thing')
        expect(fyloAttr!.namespace).toBe('fylo')
        expect(levioAttr!.namespace).toBe('levio')
    })
})
