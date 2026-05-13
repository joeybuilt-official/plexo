// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 cleanup — canonical acceptance tests.
 *
 * Five lifecycle probes using a stateful in-memory DB mock.
 * No real database or network required.
 *
 *  1. Stale-Go — language switch supersedes old fact
 *  2. Scope — tab/space preferences co-exist when domains differ
 *  3. Confidence — retrieval_count increments on query
 *  4. User-authored immunity — anchored fact survives a conflicting write
 *  5. Hybrid retrieval — queryMemory mode param reaches db.execute
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Hoisted variables for mock factories ─────────────────────────────────────

const { mockCallModel } = vi.hoisted(() => ({ mockCallModel: vi.fn() }))

// ── Stateful DB mock ──────────────────────────────────────────────────────────

interface MockRow {
    id: string
    workspace_id: string
    type: string
    content: string
    shorthand: string | null
    metadata: Record<string, unknown>
    tier: string
    namespace: string
    created_at: Date
    similarity: number
    fact_type: string | null
    subject: string | null
    predicate: string | null
    object: string | null
    domain: string | null
    confidence: number
    is_anchored: boolean
    superseded_by: string | null
    invalid_at: Date | null
    retrieval_count: number
    last_retrieved_at: Date | null
    user_id: string | null
    scope_level: string | null
    source: string | null
}

const store = new Map<string, MockRow>()

function makeRow(overrides: Partial<MockRow> & { id: string; workspace_id: string }): MockRow {
    return {
        type: 'pattern', content: '', shorthand: null, metadata: {}, tier: 'active',
        namespace: 'default', created_at: new Date(), similarity: 1,
        fact_type: null, subject: null, predicate: null, object: null, domain: null,
        confidence: 1.0, is_anchored: false, superseded_by: null, invalid_at: null,
        retrieval_count: 0, last_retrieved_at: null, user_id: null, scope_level: 'workspace', source: null,
        ...overrides,
    }
}

// Stateful execute: SELECT or UPDATE memory_entries rows.
// Discriminates by whether SQL text starts with UPDATE vs SELECT.
function statefulExecute(sqlObj: { values: unknown[]; strings?: string[] }): unknown[] {
    const vals = sqlObj?.values ?? []
    const strings = sqlObj?.strings ?? []
    const sqlText = strings.join(' ').trim()
    const uuids = vals.filter(v => typeof v === 'string' && /^[0-9a-f-]{36}$/.test(v as string)) as string[]

    // Supersession UPDATE: SET invalid_at = NOW(), superseded_by = ...
    if (sqlText.startsWith('UPDATE') && sqlText.includes('SET invalid_at')) {
        // write.ts passes: values = [newId, supersededId]
        const [newId, oldId] = uuids
        if (oldId) {
            const row = store.get(oldId)
            if (row) { row.invalid_at = new Date(); row.superseded_by = newId ?? null }
        }
        return []
    }

    // Retrieval bump UPDATE
    if (sqlText.startsWith('UPDATE') && sqlText.includes('retrieval_count')) {
        for (const id of uuids) {
            const row = store.get(id)
            if (row) { row.retrieval_count += 1; row.last_retrieved_at = new Date() }
        }
        return []
    }

    // Any other UPDATE (tier, etc.)
    if (sqlText.startsWith('UPDATE')) return []

    // SELECT: filter store by workspaceId (vals[0]) and optionally predicate (vals[1])
    const workspaceId = typeof vals[0] === 'string' ? vals[0] : null
    const predicate = typeof vals[1] === 'string' ? vals[1] : null

    if (!workspaceId) return []

    return Array.from(store.values())
        .filter(r => {
            if (r.workspace_id !== workspaceId) return false
            if (r.superseded_by !== null || r.invalid_at !== null) return false
            if (predicate && r.predicate !== predicate) return false
            return true
        })
        .map(r => ({
            ...r,
            // Mirror SQL alias: is_anchored AS "isAnchored"
            isAnchored: r.is_anchored,
        }))
}

vi.mock('@plexo/db', () => ({
    db: {
        insert: vi.fn(() => ({
            // Drizzle passes camelCase; normalize to snake_case for the store.
            values: vi.fn((row: Record<string, unknown>) => {
                const id = row['id'] as string | undefined
                const wsId = (row['workspaceId'] ?? row['workspace_id']) as string | undefined
                if (id && wsId) {
                    store.set(id, makeRow({
                        id,
                        workspace_id: wsId,
                        predicate: (row['predicate'] as string | null) ?? null,
                        object: (row['object'] as string | null) ?? null,
                        domain: (row['domain'] as string | null) ?? null,
                        fact_type: (row['factType'] ?? row['fact_type'] as string | null) as string | null,
                        subject: (row['subject'] as string | null) ?? null,
                        confidence: typeof row['confidence'] === 'number' ? row['confidence'] : 1.0,
                        is_anchored: Boolean(row['isAnchored'] ?? row['is_anchored']),
                        source: (row['source'] as string | null) ?? null,
                        content: (row['content'] as string | null) ?? '',
                    }))
                }
                return Promise.resolve()
            }),
        })),
        execute: vi.fn((sqlObj: unknown) => Promise.resolve(statefulExecute(sqlObj as { values: unknown[] }))),
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings: Array.from(strings), values: vals, _kind: 'sql' }),
        { join: vi.fn((arr: unknown[]) => arr), raw: vi.fn((s: string) => s) },
    ),
    memoryEntries: { id: 'id' },
}))

vi.mock('../../providers/call-model.js', () => ({ callModel: (...args: unknown[]) => mockCallModel(...args) }))
vi.mock('../../providers/registry.js', () => ({
    resolveModel: vi.fn(async () => ({ model: 'test-model', meta: { provider: 'test' } })),
    resolveModelFromEnv: vi.fn(() => 'test-model'),
}))

import { writeFact } from '../write.js'

beforeEach(async () => {
    store.clear()
    mockCallModel.mockReset()
    const { db } = await import('@plexo/db')
    vi.mocked(db.execute).mockImplementation(
        ((sqlObj: unknown) => Promise.resolve(statefulExecute(sqlObj as { values: unknown[] }))) as unknown as typeof db.execute
    )
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function factInStore(ws: string, pred: string, obj: string) {
    return Array.from(store.values()).find(r => r.workspace_id === ws && r.predicate === pred && r.object === obj)
}

function activeFactsInStore(ws: string, pred: string) {
    return Array.from(store.values()).filter(r =>
        r.workspace_id === ws && r.predicate === pred &&
        r.superseded_by === null && r.invalid_at === null
    )
}

// ── Stale-Go probe ─────────────────────────────────────────────────────────────

describe('stale-Go probe', () => {
    const WS = 'ws-go-probe'

    it('Rust fact active, Go fact superseded after language switch', async () => {
        // Turn 1: write Go (no existing facts → NONE)
        const r1 = await writeFact({
            workspaceId: WS, factType: 'skill', subject: 'user',
            predicate: 'uses as primary language', object: 'Go',
            domain: 'languages', confidence: 0.9, source: 'chat',
        })
        expect(r1.action).toBe('NONE')
        const goId = r1.id

        // Go fact is in store and active
        expect(store.get(goId)?.object).toBe('Go')
        expect(store.get(goId)?.superseded_by).toBeNull()

        // Turn 2: write Rust — LLM says UPDATE
        mockCallModel.mockResolvedValue({ object: { action: 'UPDATE' } })
        const r2 = await writeFact({
            workspaceId: WS, factType: 'skill', subject: 'user',
            predicate: 'uses as primary language', object: 'Rust',
            domain: 'languages', confidence: 0.9, source: 'chat',
        })

        expect(r2.action).toBe('UPDATE')
        expect(r2.supersededId).toBe(goId)

        // Rust fact exists
        const rustFact = factInStore(WS, 'uses as primary language', 'Rust')
        expect(rustFact).toBeTruthy()

        // Go fact is superseded
        const goAfter = store.get(goId)!
        expect(goAfter.superseded_by).not.toBeNull()
        expect(goAfter.invalid_at).not.toBeNull()

        // Only Rust is active
        const active = activeFactsInStore(WS, 'uses as primary language')
        expect(active).toHaveLength(1)
        expect(active[0]!.object).toBe('Rust')
    })
})

// ── Scope probe ───────────────────────────────────────────────────────────────

describe('scope probe', () => {
    const WS = 'ws-scope-probe'

    it('Python tabs and JS spaces both survive as active facts', async () => {
        await writeFact({
            workspaceId: WS, factType: 'preference', subject: 'user',
            predicate: 'uses', object: 'tabs', domain: 'python',
            confidence: 0.8, source: 'chat',
        })

        mockCallModel.mockResolvedValue({ object: { action: 'SCOPE' } })

        await writeFact({
            workspaceId: WS, factType: 'preference', subject: 'user',
            predicate: 'uses', object: 'spaces', domain: 'js',
            confidence: 0.8, source: 'chat',
        })

        const tabs = factInStore(WS, 'uses', 'tabs')
        const spaces = factInStore(WS, 'uses', 'spaces')

        expect(tabs).toBeTruthy()
        expect(spaces).toBeTruthy()
        expect(tabs?.superseded_by).toBeNull()
        expect(spaces?.superseded_by).toBeNull()

        // Both active
        const active = activeFactsInStore(WS, 'uses')
        expect(active.length).toBeGreaterThanOrEqual(2)
    })
})

// ── Confidence / retrieval_count probe ────────────────────────────────────────

describe('confidence probe', () => {
    it('retrieval_count increments when db.execute UPDATE is called', async () => {
        const WS = 'ws-confidence-probe'
        const factId = crypto.randomUUID()
        store.set(factId, makeRow({ id: factId, workspace_id: WS, predicate: 'uses', object: 'postgres', retrieval_count: 0 }))

        const { db } = await import('@plexo/db')
        // Simulate 5 retrieval bumps
        for (let i = 0; i < 5; i++) {
            await db.execute({
                strings: ['UPDATE memory_entries SET retrieval_count = retrieval_count + 1 WHERE id = ANY(', '::uuid[])'],
                values: [factId],
            } as unknown as Parameters<typeof db.execute>[0])
        }

        expect(store.get(factId)?.retrieval_count).toBe(5)
    })
})

// ── User-authored immunity probe ──────────────────────────────────────────────

describe('user-authored immunity probe', () => {
    const WS = 'ws-immunity-probe'

    it('anchored Vim fact unchanged after Neovim turn is ingested', async () => {
        // Pre-seed anchored Vim fact directly in store
        const vimId = crypto.randomUUID()
        store.set(vimId, makeRow({
            id: vimId, workspace_id: WS, predicate: 'uses', object: 'Vim',
            domain: 'tools', is_anchored: true,
        }))

        // writeFact Neovim — resolveConflict returns NONE for anchored existing
        const result = await writeFact({
            workspaceId: WS, factType: 'skill', subject: 'user',
            predicate: 'uses', object: 'Neovim', domain: 'tools',
            confidence: 0.8, source: 'chat',
        })

        // Vim unchanged
        const vimAfter = store.get(vimId)!
        expect(vimAfter.superseded_by).toBeNull()
        expect(vimAfter.invalid_at).toBeNull()
        expect(vimAfter.is_anchored).toBe(true)

        // Neovim written alongside
        expect(result.action).toBe('NONE')
        expect(factInStore(WS, 'uses', 'Neovim')).toBeTruthy()

        // No LLM call for anchored fact
        expect(mockCallModel).not.toHaveBeenCalled()
    })
})

// Hybrid retrieval probe removed — postgres queryMemory deleted in Phase F.1
// (ADR 0014). Read path now goes through readFromGraphiti; see
// memory/__tests__/read-backend.test.ts for coverage of the new path.
