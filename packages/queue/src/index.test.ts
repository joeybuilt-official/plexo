// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'

const setSpy = vi.fn()
const whereSpy = vi.fn(async () => undefined)

vi.mock('@plexo/db', () => ({
    db: {
        update: vi.fn(() => ({
            set: (arg: unknown) => { setSpy(arg); return { where: whereSpy } },
        })),
    },
    eq: vi.fn(),
    and: vi.fn(),
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        { join: vi.fn() },
    ),
    asc: vi.fn(),
    inArray: vi.fn(),
    tasks: { id: 'id' },
}))

// ADR-0045 Phase 2: the drizzle adapter now imports operators from drizzle-orm
// directly (not via the @plexo/db barrel), so stub them here too.
vi.mock('drizzle-orm', () => ({
    eq: vi.fn(),
    and: vi.fn(),
    sql: Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
        { join: vi.fn() },
    ),
    asc: vi.fn(),
    inArray: vi.fn(),
}))

const { complete } = await import('./index.js')

describe('queue complete() — Phase M pending-score guard', () => {
    beforeEach(() => { setSpy.mockClear() })

    const base = { outcomeSummary: 's', tokensIn: 1, tokensOut: 2, costUsd: 0 }

    it('omits qualityScore when null (pending) so completeTask cannot clobber the async-patched judge score', async () => {
        await complete('t1', { qualityScore: null, ...base })
        const arg = setSpy.mock.calls[0]![0] as Record<string, unknown>
        expect('qualityScore' in arg).toBe(false)
        expect(arg.status).toBe('complete')
        expect(arg.outcomeSummary).toBe('s')
    })

    it('sets qualityScore when a real (settled) score is provided', async () => {
        await complete('t2', { qualityScore: 0.82, ...base })
        const arg = setSpy.mock.calls[0]![0] as Record<string, unknown>
        expect(arg.qualityScore).toBe(0.82)
    })

    it('treats 0 as a real score (not pending)', async () => {
        await complete('t3', { qualityScore: 0, ...base })
        const arg = setSpy.mock.calls[0]![0] as Record<string, unknown>
        expect('qualityScore' in arg).toBe(true)
        expect(arg.qualityScore).toBe(0)
    })
})
