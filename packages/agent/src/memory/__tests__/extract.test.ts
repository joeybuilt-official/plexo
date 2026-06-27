// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 cleanup test suite — extraction pipeline.
 *
 * Ten synthetic turn cases covering the key extraction contracts:
 * preferences, implicit preferences, temporal supersession, team scope,
 * questions, hypotheticals, compound statements, identity, and error paths.
 *
 * All LLM calls and DB calls are mocked. No real DB or network required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock is hoisted before imports, so any variables referenced directly
// inside the factory object must be declared via vi.hoisted().
const { mockCallModel, mockInsertValues } = vi.hoisted(() => ({
    mockCallModel: vi.fn(),
    mockInsertValues: vi.fn(async (_values?: Record<string, unknown>) => undefined),
}))

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => ({
    db: {
        insert: vi.fn(() => ({ values: mockInsertValues })),
        execute: vi.fn(async () => []),
    },
    sql: Object.assign(
        (strings: TemplateStringsArray, ...vals: unknown[]) => ({ strings, values: vals, _kind: 'sql' }),
        { join: vi.fn((arr: unknown[]) => arr), raw: vi.fn((s: string) => s) },
    ),
    memoryEntries: { id: 'id' },
}))

// From __tests__/, providers are at ../../providers/
vi.mock('../../providers/call-model.js', () => ({ callModel: (...args: unknown[]) => mockCallModel(...args) }))
// Spread the real module so runtime exports the router-v2 chain now pulls in
// (e.g. DEFAULT_MODEL_ROUTING via enumerate.ts) stay present; override only the
// two resolver fns the worker calls.
vi.mock('../../providers/registry.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../providers/registry.js')>()
    return {
        ...actual,
        resolveModel: vi.fn(async () => ({ model: 'test-model', meta: { provider: 'test' } })),
        resolveModelFromEnv: vi.fn(() => 'test-model'),
    }
})
vi.mock('../../providers/settings-from-instances.js', () => ({
    loadSettingsFromInstances: vi.fn(async () => null),
}))
// store.js relative to extract-worker.ts is ../memory/store.js; from __tests__/ that's ../store.js
vi.mock('../store.js', () => ({ embed: vi.fn(async () => null) }))

// Phase 5 closure: shouldWritePostgres is always false in production.
// Force postgres path so these tests exercise the insert logic.
vi.mock('../write-backend.js', () => ({
    getWriteBackend: () => 'postgres',
    shouldWritePostgres: () => true,
}))

import { extractTurn } from '../extract-worker.js'
import { db } from '@plexo/db'

const dbInsert = vi.mocked(db.insert)

beforeEach(() => {
    mockCallModel.mockReset()
    mockInsertValues.mockReset()
    dbInsert.mockClear()
})

function fakeTurn(overrides: { user?: string; assistant?: string } = {}) {
    return {
        workspaceId: 'ws-test',
        userMessage: overrides.user ?? 'default user message that is long enough',
        assistantReply: overrides.assistant ?? 'default assistant reply',
        sessionId: 'sess-1',
        source: 'chat',
    }
}

function callModelReturning(facts: unknown[]) {
    mockCallModel.mockResolvedValue({ object: { facts } })
}

function callModelReturningEmpty() {
    mockCallModel.mockResolvedValue({ object: { facts: [] } })
}

// ── Case 1: Simple preference ────────────────────────────────────────────────

describe('case 1: simple preference', () => {
    it('extracts a fact with correct predicate and object', async () => {
        callModelReturning([{
            factType: 'preference',
            subject: 'user',
            predicate: 'prefers',
            object: 'TypeScript over JavaScript',
            domain: 'languages',
            confidence: 0.9,
        }])

        await extractTurn(fakeTurn({ user: 'I always prefer TypeScript over plain JavaScript for new projects.' }))

        expect(dbInsert).toHaveBeenCalledOnce()
        const insertArg = mockInsertValues.mock.calls[0]?.[0]
        expect(insertArg).toMatchObject({
            factType: 'preference',
            predicate: 'prefers',
            object: 'TypeScript over JavaScript',
        })
    })
})

// ── Case 2: Implicit preference ──────────────────────────────────────────────

describe('case 2: implicit preference', () => {
    it('extracts a fact with preference type from implicit signal', async () => {
        callModelReturning([{
            factType: 'preference',
            subject: 'user',
            predicate: 'dislikes',
            object: 'spaces for indentation',
            domain: 'coding-style',
            confidence: 0.75,
        }])

        await extractTurn(fakeTurn({ user: 'Ugh, spaces again — everyone on this team uses spaces and I hate it.' }))

        const insertArg = mockInsertValues.mock.calls[0]?.[0]
        expect(insertArg?.factType).toBe('preference')
        expect(insertArg?.predicate).toBe('dislikes')
    })
})

// ── Case 3: Temporal supersession ────────────────────────────────────────────

describe('case 3: temporal supersession', () => {
    it('extracts a supersession fact with appropriate predicate', async () => {
        callModelReturning([{
            factType: 'skill',
            subject: 'user',
            predicate: 'migrated away from',
            object: 'Go as primary language',
            domain: 'languages',
            confidence: 0.85,
        }])

        await extractTurn(fakeTurn({ user: 'We moved off Go last month — everything is in Python now.' }))

        const insertArg = mockInsertValues.mock.calls[0]?.[0]
        expect(insertArg?.factType).toBe('skill')
        expect(insertArg?.object).toContain('Go')
    })
})

// ── Case 4: Team scope ───────────────────────────────────────────────────────

describe('case 4: team scope', () => {
    it('extracts a fact with subject = team, not user', async () => {
        callModelReturning([{
            factType: 'context',
            subject: 'team',
            predicate: 'uses',
            object: 'Postgres as primary database',
            domain: 'infrastructure',
            confidence: 0.9,
        }])

        await extractTurn(fakeTurn({ user: 'Our team uses Postgres for everything — it\'s the standard here.' }))

        const insertArg = mockInsertValues.mock.calls[0]?.[0]
        expect(insertArg?.subject).toBe('team')
    })
})

// ── Case 5: Question → no facts ──────────────────────────────────────────────

describe('case 5: question', () => {
    it('returns zero facts for a question turn', async () => {
        callModelReturningEmpty()

        await extractTurn(fakeTurn({ user: 'Should I use tabs or spaces for Python indentation?' }))

        expect(dbInsert).not.toHaveBeenCalled()
    })
})

// ── Case 6: Hypothetical → no facts ──────────────────────────────────────────

describe('case 6: hypothetical', () => {
    it('returns zero facts for a hypothetical statement', async () => {
        callModelReturningEmpty()

        await extractTurn(fakeTurn({ user: 'If I were to rewrite this in Rust, what would you recommend?' }))

        expect(dbInsert).not.toHaveBeenCalled()
    })
})

// ── Case 7: User_authored existing fact — extract still inserts ───────────────

describe('case 7: user_authored existing fact — new fact written alongside', () => {
    it('inserts the extracted fact (conflict check is in write.ts, not extract-worker)', async () => {
        callModelReturning([{
            factType: 'skill',
            subject: 'user',
            predicate: 'switched to',
            object: 'Neovim',
            domain: 'tools',
            confidence: 0.8,
        }])

        await extractTurn(fakeTurn({ user: 'I switched to Neovim last week, loving the lua config.' }))

        expect(dbInsert).toHaveBeenCalledOnce()
    })
})

// ── Case 8: Compound statement → multiple facts ───────────────────────────────

describe('case 8: compound statement', () => {
    it('writes multiple atomic facts from a single turn', async () => {
        callModelReturning([
            { factType: 'preference', subject: 'user', predicate: 'uses', object: 'React for frontend', domain: 'web', confidence: 0.85 },
            { factType: 'preference', subject: 'user', predicate: 'uses', object: 'Fastify for backend', domain: 'web', confidence: 0.85 },
            { factType: 'context', subject: 'user', predicate: 'works in', object: 'TypeScript monorepo', domain: 'stack', confidence: 0.8 },
        ])

        await extractTurn(fakeTurn({ user: 'I use React on the frontend, Fastify on the backend, all in a TypeScript monorepo.' }))

        // extract-worker caps at 3
        expect(mockInsertValues.mock.calls.length).toBe(3)
    })
})

// ── Case 9: Identity statement ────────────────────────────────────────────────

describe('case 9: identity statement', () => {
    it('extracts identity factType with high confidence seed', async () => {
        callModelReturning([{
            factType: 'identity',
            subject: 'user',
            predicate: 'is',
            object: 'a backend engineer',
            domain: 'role',
            confidence: 0.9,
        }])

        await extractTurn(fakeTurn({ user: 'I\'m a backend engineer — I\'ve been doing server-side work for 8 years.' }))

        const insertArg = mockInsertValues.mock.calls[0]?.[0]
        expect(insertArg?.factType).toBe('identity')
        expect(insertArg?.confidence).toBeGreaterThanOrEqual(0.85)
    })
})

// ── Case 10: Zod parse failure → returns empty, no throw ─────────────────────

describe('case 10: Zod parse failure on malformed LLM response', () => {
    it('returns without inserting and does not throw', async () => {
        mockCallModel.mockRejectedValue(new Error('model returned invalid JSON'))

        await expect(
            extractTurn(fakeTurn({ user: 'I prefer tabs for all my projects including Python and JS.' }))
        ).resolves.not.toThrow()

        expect(dbInsert).not.toHaveBeenCalled()
    })
})
