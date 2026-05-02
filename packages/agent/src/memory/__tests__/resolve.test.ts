// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 cleanup test suite — conflict resolution.
 *
 * Tests resolveConflict() (pure/mocked-LLM) and writeFact() (DB + resolution).
 * No real DB or network required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.hoisted ensures these are available before vi.mock factories run.
const { mockDbExecute, mockInsertValues, mockCallModel } = vi.hoisted(() => ({
    mockDbExecute: vi.fn(async () => [] as unknown[]),
    mockInsertValues: vi.fn(async () => undefined),
    mockCallModel: vi.fn(),
}))

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        insert: vi.fn(() => ({ values: mockInsertValues })),
        execute: mockDbExecute,
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, values: vals, _kind: 'sql' }),
        { join: vi.fn((arr: unknown[]) => arr), raw: vi.fn((s: string) => s) },
    ),
    memoryEntries: { id: 'id' },
}))

vi.mock('../../providers/call-model.js', () => ({ callModel: (...args: unknown[]) => mockCallModel(...args) }))
vi.mock('../../providers/registry.js', () => ({
    resolveModel: vi.fn(async () => ({ model: 'test-model', meta: { provider: 'test' } })),
    resolveModelFromEnv: vi.fn(() => 'test-model'),
}))

import { resolveConflict, writeFact } from '../write.js'

beforeEach(() => {
    mockCallModel.mockReset()
    mockDbExecute.mockReset()
    mockInsertValues.mockReset()
    mockDbExecute.mockResolvedValue([])
})

// ── resolveConflict ───────────────────────────────────────────────────────────

describe('resolveConflict', () => {
    it('exact match (predicate + object + domain) → UPDATE without LLM call', async () => {
        const action = await resolveConflict(
            { predicate: 'uses', object: 'TypeScript', domain: 'languages', factType: 'preference' },
            { id: 'old-1', predicate: 'uses', object: 'TypeScript', domain: 'languages', factType: 'preference', isAnchored: false },
        )
        expect(action).toBe('UPDATE')
        expect(mockCallModel).not.toHaveBeenCalled()
    })

    it('temporal supersession → LLM returns UPDATE', async () => {
        mockCallModel.mockResolvedValue({ object: { action: 'UPDATE', rationale: 'language changed' } })

        const action = await resolveConflict(
            { predicate: 'uses', object: 'Rust', domain: 'languages', factType: 'preference' },
            { id: 'old-1', predicate: 'uses', object: 'Go', domain: 'languages', factType: 'preference', isAnchored: false },
        )
        expect(action).toBe('UPDATE')
        expect(mockCallModel).toHaveBeenCalledOnce()
    })

    it('scope narrowing (different domains) → SCOPE, both facts survive', async () => {
        mockCallModel.mockResolvedValue({ object: { action: 'SCOPE', rationale: 'different language domains' } })

        const action = await resolveConflict(
            { predicate: 'uses', object: 'spaces', domain: 'js', factType: 'preference' },
            { id: 'old-1', predicate: 'uses', object: 'tabs', domain: 'python', factType: 'preference', isAnchored: false },
        )
        expect(action).toBe('SCOPE')
    })

    it('user_authored (isAnchored = true) → NONE without LLM call', async () => {
        const action = await resolveConflict(
            { predicate: 'uses', object: 'Neovim', domain: 'tools', factType: 'skill' },
            { id: 'anchored-1', predicate: 'uses', object: 'Vim', domain: 'tools', factType: 'skill', isAnchored: true },
        )
        expect(action).toBe('NONE')
        expect(mockCallModel).not.toHaveBeenCalled()
    })

    it('unrelated facts same domain → NONE', async () => {
        mockCallModel.mockResolvedValue({ object: { action: 'NONE', rationale: 'unrelated facts' } })

        const action = await resolveConflict(
            { predicate: 'uses', object: 'Docker', domain: 'infrastructure', factType: 'skill' },
            { id: 'old-1', predicate: 'uses', object: 'Postgres', domain: 'infrastructure', factType: 'skill', isAnchored: false },
        )
        expect(action).toBe('NONE')
    })

    it('partial conflict → LLM decides (accepts UPDATE or SCOPE)', async () => {
        mockCallModel.mockResolvedValue({ object: { action: 'SCOPE' } })

        const action = await resolveConflict(
            { predicate: 'uses', object: 'React for new projects', domain: 'frontend', factType: 'preference' },
            { id: 'old-1', predicate: 'uses', object: 'Vue', domain: 'frontend', factType: 'preference', isAnchored: false },
        )
        expect(['UPDATE', 'SCOPE']).toContain(action)
        expect(mockCallModel).toHaveBeenCalledOnce()
    })
})

// ── writeFact ─────────────────────────────────────────────────────────────────

describe('writeFact', () => {
    const base = {
        workspaceId: 'ws-1',
        factType: 'preference' as const,
        subject: 'user',
        predicate: 'uses',
        object: 'Rust',
        domain: 'languages',
        confidence: 0.85,
        source: 'chat',
    }

    it('inserts a new fact when no existing facts found (action = NONE)', async () => {
        // db.execute returns empty array → no conflict
        mockDbExecute.mockResolvedValueOnce([])

        const result = await writeFact(base)

        expect(result.action).toBe('NONE')
        expect(result.id).toBeTruthy()
        expect(mockInsertValues).toHaveBeenCalledOnce()
    })

    it('UPDATE path: inserts new fact then invalidates old, supersededId set', async () => {
        // Existing fact with same predicate, different object
        mockDbExecute.mockResolvedValueOnce([{
            id: 'old-fact',
            predicate: 'uses',
            object: 'Go',
            domain: 'languages',
            factType: 'preference',
            isAnchored: false,
        }])
        mockCallModel.mockResolvedValue({ object: { action: 'UPDATE' } })
        mockDbExecute.mockResolvedValueOnce([]) // UPDATE query stub

        const result = await writeFact(base)

        expect(result.action).toBe('UPDATE')
        expect(result.supersededId).toBe('old-fact')
        expect(mockInsertValues).toHaveBeenCalledOnce()
        expect(mockDbExecute).toHaveBeenCalledTimes(2) // SELECT + UPDATE
    })

    it('anchored existing fact → inserts new fact alongside (action = NONE, no LLM call)', async () => {
        mockDbExecute.mockResolvedValueOnce([{
            id: 'anchored-fact',
            predicate: 'uses',
            object: 'Vim',
            domain: 'tools',
            factType: 'skill',
            isAnchored: true,
        }])

        const result = await writeFact({
            ...base,
            predicate: 'uses',
            object: 'Neovim',
            domain: 'tools',
            factType: 'skill',
        })

        expect(result.action).toBe('NONE')
        expect(mockCallModel).not.toHaveBeenCalled()
        expect(mockInsertValues).toHaveBeenCalledOnce()
    })
})
