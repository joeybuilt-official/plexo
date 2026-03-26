import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockExecute = vi.fn()

vi.mock('@plexo/db', () => ({
    db: { execute: (...args: unknown[]) => mockExecute(...args) },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values, text: strings.join('?') }),
}))

const mockGenerateText = vi.fn()
vi.mock('ai', () => ({
    generateText: (...args: unknown[]) => mockGenerateText(...args),
}))

vi.mock('../providers/registry.js', () => ({
    resolveModelFromEnv: vi.fn(() => 'mock-model'),
}))

vi.mock('pino', () => ({
    default: () => ({
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
    }),
}))

import { reflectAndPromote, type ReflectCtx } from './reflect.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseCtx(overrides: Partial<ReflectCtx> = {}): ReflectCtx {
    return {
        workspaceId: 'ws-123',
        taskId: 'task-456',
        goal: 'Implement user search endpoint',
        taskType: 'coding',
        toolsUsed: ['read_file', 'write_file'],
        qualityScore: 0.9,
        outcomeSummary: 'Successfully implemented search endpoint with pagination and filtering support using Drizzle ORM.',
        stepCount: 5,
        durationMs: 12000,
        ...overrides,
    }
}

/** Count how many times mockExecute was called with SQL containing a pattern */
function dbCallsMatching(pattern: string): number {
    return mockExecute.mock.calls.filter(
        (call) => JSON.stringify(call).includes(pattern)
    ).length
}

describe('reflectAndPromote', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns immediately when reflection_enabled = false', async () => {
        // Gate 1: workspace preference returns false
        mockExecute.mockResolvedValueOnce([{ value: false }])

        await reflectAndPromote(baseCtx())

        // Only one DB call (the preference check), no inserts
        expect(mockExecute).toHaveBeenCalledTimes(1)
    })

    it('skips when qualityScore < 0.8 even if feature is enabled', async () => {
        // Gate 1: enabled
        mockExecute.mockResolvedValueOnce([{ value: true }])

        await reflectAndPromote(baseCtx({ qualityScore: 0.6 }))

        // Only the preference check
        expect(mockExecute).toHaveBeenCalledTimes(1)
        // No LLM call
        expect(mockGenerateText).not.toHaveBeenCalled()
    })

    it('inserts domain_knowledge rule when LLM returns valid JSON', async () => {
        // Gate 1: enabled
        mockExecute.mockResolvedValueOnce([{ value: true }])

        // LLM returns valid observations
        mockGenerateText.mockResolvedValueOnce({
            text: JSON.stringify([{
                key: 'reflect.coding.prefer_pagination',
                label: 'Prefer pagination',
                insight: 'Always implement cursor-based pagination for list endpoints.',
            }]),
        })

        // Upsert call succeeds
        mockExecute.mockResolvedValueOnce([])

        await reflectAndPromote(baseCtx())

        // 1 preference check + 1 upsert
        expect(mockExecute).toHaveBeenCalledTimes(2)
        expect(mockGenerateText).toHaveBeenCalledTimes(1)

        // Verify the upsert SQL contains the right values
        const upsertCall = JSON.stringify(mockExecute.mock.calls[1])
        expect(upsertCall).toContain('domain_knowledge')
        expect(upsertCall).toContain('reflection')
        expect(upsertCall).toContain('reflect.coding.prefer_pagination')
        expect(upsertCall).toContain('text_block')
    })

    it('appends with separator when existing row has 1 separator', async () => {
        // Gate 1: enabled
        mockExecute.mockResolvedValueOnce([{ value: true }])

        // LLM returns an observation with a key that will match an existing row
        mockGenerateText.mockResolvedValueOnce({
            text: JSON.stringify([{
                key: 'reflect.coding.existing_rule',
                label: 'Existing rule',
                insight: 'New insight to append.',
            }]),
        })

        // Upsert: the ON CONFLICT DO UPDATE handles append logic in SQL.
        // We just verify the upsert is called (SQL handles separator counting).
        mockExecute.mockResolvedValueOnce([])

        await reflectAndPromote(baseCtx())

        expect(mockExecute).toHaveBeenCalledTimes(2)
        // The SQL itself contains the anti-collapse logic (separator counting).
        // The CASE WHEN checks for >= 3 separators; with 1 separator it will append.
        const upsertSql = JSON.stringify(mockExecute.mock.calls[1])
        expect(upsertSql).toContain('---')
        expect(upsertSql).toContain('ON CONFLICT')
    })

    it('handles 3+ separators via SQL CASE (mature rule skip)', async () => {
        // Gate 1: enabled
        mockExecute.mockResolvedValueOnce([{ value: true }])

        mockGenerateText.mockResolvedValueOnce({
            text: JSON.stringify([{
                key: 'reflect.coding.mature_rule',
                label: 'Mature rule',
                insight: 'Should be skipped by SQL CASE.',
            }]),
        })

        // The ON CONFLICT SQL CASE handles this: when separator count >= 3,
        // it keeps the existing value. We verify the upsert is called
        // (the DB-side logic prevents overwrite).
        mockExecute.mockResolvedValueOnce([])

        await reflectAndPromote(baseCtx())

        // Upsert is still called — the SQL CASE prevents value mutation.
        expect(mockExecute).toHaveBeenCalledTimes(2)
        expect(mockGenerateText).toHaveBeenCalledTimes(1)
    })

    it('resolves cleanly when LLM returns malformed JSON', async () => {
        // Gate 1: enabled
        mockExecute.mockResolvedValueOnce([{ value: true }])

        // LLM returns non-JSON
        mockGenerateText.mockResolvedValueOnce({
            text: 'This is not valid JSON at all',
        })

        // Should not throw
        await expect(reflectAndPromote(baseCtx())).resolves.toBeUndefined()

        // Only the preference check, no upsert attempts
        expect(mockExecute).toHaveBeenCalledTimes(1)
    })
})
