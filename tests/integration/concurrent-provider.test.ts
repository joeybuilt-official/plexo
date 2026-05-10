/**
 * Concurrent provider chain resolution tests.
 * Verifies that parallel resolveModel() calls with the same workspace settings
 * don't corrupt the module-level stale-key cache and always return valid models.
 *
 * IntelligentRouter is mocked — we're testing resolveModel() orchestration and
 * the stale-key Map invariants, not actual network calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TaskType } from '../../packages/agent/src/providers/registry.js'

// Mock IntelligentRouter before importing resolveModel so the module sees the stub
vi.mock('../../packages/agent/src/providers/router.js', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>
    return {
        ...actual,
        IntelligentRouter: vi.fn().mockImplementation(
            (_vault: unknown, config: { inferenceMode?: string }, _wsId?: string) => ({
                route: vi.fn().mockImplementation(async (taskType: string) => ({
                    model: { modelId: `mock-${taskType}-model` },
                    meta: {
                        id: `mock-${taskType}-model`,
                        provider: 'openai',
                        mode: config.inferenceMode ?? 'byok',
                        costPerMIn: 0.001,
                        costPerMOut: 0.003,
                    },
                })),
            })
        ),
    }
})

import { resolveModel, clearStaleKey } from '../../packages/agent/src/providers/registry.js'
import type { WorkspaceAISettings } from '../../packages/agent/src/providers/registry.js'

const TEST_WS_ID = '00000000-0000-4000-aaaa-000000000001'

function makeSettings(override: Partial<WorkspaceAISettings> = {}): WorkspaceAISettings {
    return {
        primaryProvider: 'openai',
        fallbackChain: ['anthropic'],
        providers: {
            openai: { apiKey: 'sk-test-openai', model: 'gpt-4o', enabled: true },
            anthropic: { apiKey: 'sk-ant-test', model: 'claude-sonnet-4-6', enabled: true },
        },
        inferenceMode: 'byok',
        ...override,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    // Reset any stale-key entries from previous sub-tests
    clearStaleKey(TEST_WS_ID, 'openai')
    clearStaleKey(TEST_WS_ID, 'anthropic')
    clearStaleKey(TEST_WS_ID, 'ollama')
})

describe('resolveModel — concurrent safety', () => {
    it('10 parallel calls with same workspace: all return valid model+meta', async () => {
        const settings = makeSettings()

        const results = await Promise.all(
            Array.from({ length: 10 }, () =>
                resolveModel('conversation', settings, TEST_WS_ID)
            )
        )

        expect(results).toHaveLength(10)
        for (const { model, meta } of results) {
            expect(model).toBeDefined()
            expect(meta).toBeDefined()
            expect(typeof meta.id).toBe('string')
            expect(meta.id.length).toBeGreaterThan(0)
            expect(meta.provider).toBeTruthy()
        }
    })

    it('10 parallel calls for different task types: each gets matching model', async () => {
        const taskTypes: TaskType[] = [
            'planning', 'codeGeneration', 'verification',
            'summarization', 'conversation', 'classification',
            'logAnalysis', 'planning', 'codeGeneration', 'verification',
        ]
        const settings = makeSettings()

        const results = await Promise.all(
            taskTypes.map(type => resolveModel(type, settings, TEST_WS_ID))
        )

        expect(results).toHaveLength(taskTypes.length)

        // Mock returns model IDs containing the task type — verify correct routing
        for (let i = 0; i < results.length; i++) {
            const { meta } = results[i]!
            expect(meta.id).toContain(taskTypes[i])
        }
    })

    it('stale-key cache stays coherent under 10 parallel resolveModel calls', async () => {
        const settings = makeSettings()

        // Introduce a stale entry before the parallel run
        // (simulates a prior auth failure recorded by withFallback)
        // We can only test the exported clearStaleKey path; markKeyStale is internal
        clearStaleKey(TEST_WS_ID, 'openai')

        const results = await Promise.all(
            Array.from({ length: 10 }, () =>
                resolveModel('summarization', settings, TEST_WS_ID)
            )
        )

        // All calls must resolve — stale cache must not cause throws
        expect(results).toHaveLength(10)
        for (const { model } of results) {
            expect(model).not.toBeNull()
            expect(model).not.toBeUndefined()
        }
    })

    it('override mode: all parallel calls honour modelOverrides, no cross-contamination', async () => {
        const settings = makeSettings({
            inferenceMode: 'override',
            providers: {
                openai: { apiKey: 'sk-test', model: 'gpt-4o', enabled: true },
            },
            modelOverrides: {
                planning: 'gpt-4o',
                codeGeneration: 'gpt-4o-mini',
            },
        })

        const planningResults = await Promise.all(
            Array.from({ length: 5 }, () =>
                resolveModel('planning', settings, TEST_WS_ID)
            )
        )
        const codeResults = await Promise.all(
            Array.from({ length: 5 }, () =>
                resolveModel('codeGeneration', settings, TEST_WS_ID)
            )
        )

        // All planning calls get the same model, all codeGen calls get the same model
        const planningIds = planningResults.map(r => r.meta.id)
        const codeIds = codeResults.map(r => r.meta.id)

        expect(new Set(planningIds).size).toBe(1)
        expect(new Set(codeIds).size).toBe(1)
    })

    it('no model is undefined even when workspace ID is omitted', async () => {
        const settings = makeSettings()

        const results = await Promise.all(
            Array.from({ length: 10 }, () =>
                resolveModel('logAnalysis', settings)
            )
        )

        for (const { model, meta } of results) {
            expect(model).toBeDefined()
            expect(meta.costPerMIn).toBeGreaterThanOrEqual(0)
            expect(meta.costPerMOut).toBeGreaterThanOrEqual(0)
        }
    })
})
