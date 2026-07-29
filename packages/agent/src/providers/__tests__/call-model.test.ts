// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3 of intelligence-hardening: unit tests for the `callModel`
 * helper at `packages/agent/src/providers/call-model.ts`.
 *
 * Covers: happy path, retry on 5xx/429, no-retry on 4xx, no-retry on
 * caller AbortError, timeout vs caller-abort disambiguation, cost-gate
 * bubble-up, token-accounting log, and the `CallModelError` code
 * classification.
 *
 * Mocks `generateText` from the 'ai' module so no real network or model
 * is involved. The cost-gate is also mocked via its module path so we
 * don't need a DB fixture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { z } from 'zod'

// ── Mocks ─────────────────────────────────────────────────────────────

const generateTextMock = vi.fn()
const generateObjectMock = vi.fn()

// Phase 4: `ai` mock now exposes both generateText and generateObject,
// plus a minimal NoObjectGeneratedError surrogate whose .isInstance
// static mirrors the real SDK's type-guard so callModel's isParseError
// check recognizes it.
class FakeNoObjectGeneratedError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'NoObjectGeneratedError'
    }
    static isInstance(err: unknown): err is FakeNoObjectGeneratedError {
        return err instanceof FakeNoObjectGeneratedError
            || (!!err && typeof err === 'object' && (err as { name?: string }).name === 'NoObjectGeneratedError')
    }
}
vi.mock('ai', () => ({
    generateText: (args: unknown) => generateTextMock(args),
    generateObject: (args: unknown) => generateObjectMock(args),
    NoObjectGeneratedError: FakeNoObjectGeneratedError,
}))

const assertCostCeilingMock = vi.fn()
class FakeCostError extends Error {
    readonly code = 'COST_CEILING_EXCEEDED'
    constructor() { super('ceiling reached'); this.name = 'CostCeilingExceededError' }
}
vi.mock('../../cost-gate.js', () => ({
    assertAgentCostCeilingOk: (workspaceId: string) => assertCostCeilingMock(workspaceId),
    CostCeilingExceededError: FakeCostError,
}))

// Import AFTER the mocks so the helper picks up the stubbed modules.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- dynamic import below
let callModel: typeof import('../call-model.js').callModel
let CallModelError: typeof import('../call-model.js').CallModelError
let getSchemaRelaxedStats: typeof import('../call-model.js').getSchemaRelaxedStats
let _resetSchemaRelaxedForTest: typeof import('../call-model.js')._resetSchemaRelaxedForTest

beforeEach(async () => {
    generateTextMock.mockReset()
    generateObjectMock.mockReset()
    assertCostCeilingMock.mockReset()
    const mod = await import('../call-model.js')
    callModel = mod.callModel
    CallModelError = mod.CallModelError
    getSchemaRelaxedStats = mod.getSchemaRelaxedStats
    _resetSchemaRelaxedForTest = mod._resetSchemaRelaxedForTest
    _resetSchemaRelaxedForTest()
})

afterEach(() => {
    vi.restoreAllMocks()
})

// ── Helpers ───────────────────────────────────────────────────────────

function makeSuccess(text = 'hello', inputTokens = 10, outputTokens = 5) {
    return {
        text,
        usage: { inputTokens, outputTokens },
    }
}

function makeHttpError(status: number, message = 'http error') {
    const err = new Error(message) as Error & { status: number }
    err.status = status
    return err
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('callModel — happy path', () => {
    it('returns text + tokens + latency + attempts=1 on first-try success', async () => {
        generateTextMock.mockResolvedValueOnce(makeSuccess('result body', 100, 50))
        const result = await callModel({
            model: 'stub-model',
            prompt: 'go',
            workspaceId: 'ws-1',
            taskType: 'test',
        })
        expect(result.text).toBe('result body')
        expect(result.inputTokens).toBe(100)
        expect(result.outputTokens).toBe(50)
        expect(result.attempts).toBe(1)
        expect(result.model).toBe('stub-model')
        expect(result.latencyMs).toBeGreaterThanOrEqual(0)
        expect(generateTextMock).toHaveBeenCalledTimes(1)
    })

    it('forwards system + messages + tools + maxTokens', async () => {
        generateTextMock.mockResolvedValueOnce(makeSuccess())
        await callModel({
            model: 'stub-model',
            system: 'you are helpful',
            messages: [{ role: 'user', content: 'hi' }],
            tools: { myTool: { shape: 'any' } },
            maxTokens: 512,
            workspaceId: 'ws-1',
            taskType: 'test',
        })
        const arg = generateTextMock.mock.calls[0]![0]
        expect(arg.system).toBe('you are helpful')
        expect(arg.messages).toEqual([{ role: 'user', content: 'hi' }])
        expect(arg.tools).toEqual({ myTool: { shape: 'any' } })
        // maxTokens AND maxOutputTokens both forwarded (SDK version variance)
        expect(arg.maxTokens).toBe(512)
        expect(arg.maxOutputTokens).toBe(512)
    })
})

describe('callModel — retry on transient errors', () => {
    it('retries once on 503 and succeeds', async () => {
        generateTextMock
            .mockRejectedValueOnce(makeHttpError(503, 'upstream unavailable'))
            .mockResolvedValueOnce(makeSuccess('ok'))
        const result = await callModel({ model: 'm', prompt: 'p' })
        expect(result.attempts).toBe(2)
        expect(result.text).toBe('ok')
    })

    it('retries on 429', async () => {
        generateTextMock
            .mockRejectedValueOnce(makeHttpError(429, 'rate limited'))
            .mockResolvedValueOnce(makeSuccess())
        const result = await callModel({ model: 'm', prompt: 'p' })
        expect(result.attempts).toBe(2)
    })

    it('retries on a bare "Too Many Requests" error with no parseable status (ollama_cloud shape)', async () => {
        generateTextMock
            .mockRejectedValueOnce(new Error('Too Many Requests'))
            .mockResolvedValueOnce(makeSuccess())
        const result = await callModel({ model: 'm', prompt: 'p' })
        expect(result.attempts).toBe(2)
    })

    it('retries on network error with no status', async () => {
        generateTextMock
            .mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'))
            .mockResolvedValueOnce(makeSuccess())
        const result = await callModel({ model: 'm', prompt: 'p' })
        expect(result.attempts).toBe(2)
    })

    it('gives up after 2 attempts and throws CallModelError CALL_MODEL_5XX', async () => {
        generateTextMock
            .mockRejectedValueOnce(makeHttpError(503))
            .mockRejectedValueOnce(makeHttpError(503))
        let caught: unknown
        try {
            await callModel({ model: 'm', prompt: 'p' })
        } catch (e) { caught = e }
        expect(caught).toBeInstanceOf(CallModelError)
        expect((caught as InstanceType<typeof CallModelError>).code).toBe('CALL_MODEL_5XX')
        expect(generateTextMock).toHaveBeenCalledTimes(2)
    })
})

describe('callModel — no-retry cases', () => {
    it('does NOT retry on 400', async () => {
        generateTextMock.mockRejectedValueOnce(makeHttpError(400, 'bad request'))
        await expect(callModel({ model: 'm', prompt: 'p' })).rejects.toThrow(CallModelError)
        expect(generateTextMock).toHaveBeenCalledTimes(1)
    })

    it('throws CALL_MODEL_4XX on 403', async () => {
        generateTextMock.mockRejectedValueOnce(makeHttpError(403, 'forbidden'))
        try {
            await callModel({ model: 'm', prompt: 'p' })
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(CallModelError)
            expect((e as InstanceType<typeof CallModelError>).code).toBe('CALL_MODEL_4XX')
        }
    })

    it('throws CALL_MODEL_ABORTED when caller aborts', async () => {
        const controller = new AbortController()
        generateTextMock.mockImplementationOnce(async () => {
            const err = new Error('aborted') as Error & { name: string }
            err.name = 'AbortError'
            throw err
        })
        controller.abort()
        try {
            await callModel({ model: 'm', prompt: 'p', signal: controller.signal })
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(CallModelError)
            expect((e as InstanceType<typeof CallModelError>).code).toBe('CALL_MODEL_ABORTED')
        }
        expect(generateTextMock).toHaveBeenCalledTimes(1)
    })
})

describe('callModel — timeout vs caller-abort disambiguation', () => {
    it('classifies as CALL_MODEL_TIMEOUT when the wall-clock fires and caller signal is still live', async () => {
        generateTextMock.mockImplementationOnce(async (args: { abortSignal?: AbortSignal }) => {
            await new Promise((resolve, reject) => {
                const s = args.abortSignal
                if (!s) return resolve(null)
                s.addEventListener('abort', () => reject(new Error('aborted')))
            })
            return makeSuccess()
        })
        const caller = new AbortController()
        try {
            await callModel({
                model: 'm',
                prompt: 'p',
                signal: caller.signal,
                stepTimeoutMs: 25,
            })
            throw new Error('should have timed out')
        } catch (e) {
            expect(e).toBeInstanceOf(CallModelError)
            expect((e as InstanceType<typeof CallModelError>).code).toBe('CALL_MODEL_TIMEOUT')
            // Caller signal must still be alive — only the wall-clock fired
            expect(caller.signal.aborted).toBe(false)
        }
    })
})

describe('callModel — cost gate integration', () => {
    it('calls assertAgentCostCeilingOk when enforceCostCeiling+workspaceId are set', async () => {
        assertCostCeilingMock.mockResolvedValueOnce({ state: 'ok' })
        generateTextMock.mockResolvedValueOnce(makeSuccess())
        await callModel({
            model: 'm',
            prompt: 'p',
            workspaceId: 'ws-1',
            enforceCostCeiling: true,
        })
        expect(assertCostCeilingMock).toHaveBeenCalledWith('ws-1')
    })

    it('skips cost gate when enforceCostCeiling is not set', async () => {
        generateTextMock.mockResolvedValueOnce(makeSuccess())
        await callModel({ model: 'm', prompt: 'p', workspaceId: 'ws-1' })
        expect(assertCostCeilingMock).not.toHaveBeenCalled()
    })

    it('re-throws CostCeilingExceededError unchanged (NOT wrapped as CALL_MODEL_*)', async () => {
        assertCostCeilingMock.mockRejectedValueOnce(new FakeCostError())
        try {
            await callModel({
                model: 'm',
                prompt: 'p',
                workspaceId: 'ws-1',
                enforceCostCeiling: true,
            })
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(FakeCostError)
            expect((e as FakeCostError).code).toBe('COST_CEILING_EXCEEDED')
            expect(e).not.toBeInstanceOf(CallModelError)
        }
        // generateText should never have been called
        expect(generateTextMock).not.toHaveBeenCalled()
    })
})

// ── Phase 4 — schema-mode tests ───────────────────────────────────────

describe('callModel — schema mode (Phase 4)', () => {
    const TestSchema = z.object({
        score: z.number(),
        reason: z.string(),
    })

    it('routes to generateObject when `schema` is provided and returns the parsed object', async () => {
        generateObjectMock.mockResolvedValueOnce({
            object: { score: 0.9, reason: 'solid' },
            usage: { inputTokens: 12, outputTokens: 6 },
        })

        const result = await callModel({
            model: 'stub-model',
            prompt: 'judge this',
            schema: TestSchema,
        })

        // Type-level: result.object is z.infer<typeof TestSchema>
        expect(result.object).toEqual({ score: 0.9, reason: 'solid' })
        expect(result.text).toBe('') // always empty in schema mode
        expect(result.inputTokens).toBe(12)
        expect(result.outputTokens).toBe(6)
        expect(result.attempts).toBe(1)

        // generateText must NOT have been called
        expect(generateTextMock).not.toHaveBeenCalled()
        expect(generateObjectMock).toHaveBeenCalledTimes(1)

        // Forwarded args: schema is passed through; abortSignal is composed
        const arg = generateObjectMock.mock.calls[0]![0]
        expect(arg.schema).toBe(TestSchema)
        expect(arg.prompt).toBe('judge this')
        expect(arg.abortSignal).toBeInstanceOf(AbortSignal)
    })

    it('wraps schema parse/validation failure as CallModelError CALL_MODEL_PARSE and does NOT double-retry', async () => {
        // Simulate the SDK surfacing a parse failure after its internal
        // retry loop has already exhausted. callModel must not re-retry
        // at the outer layer (generateObject already retried twice).
        // Phase I Stage 2: the wrapper now ALSO attempts a same-model
        // repair via generateText (C5). For this test we provide a
        // generateText response that doesn't parse as valid JSON, so the
        // repair fails too — the terminal error must still surface as
        // CALL_MODEL_PARSE and generateObject must still have been
        // called only once.
        generateObjectMock.mockRejectedValueOnce(new FakeNoObjectGeneratedError('could not parse object from model output'))
        generateTextMock.mockResolvedValueOnce({
            text: 'sorry, I cannot produce JSON',
            usage: { inputTokens: 1, outputTokens: 1 },
        })

        let caught: unknown
        try {
            await callModel({
                model: 'stub-model',
                prompt: 'judge this',
                schema: TestSchema,
            })
            throw new Error('should have thrown')
        } catch (e) { caught = e }

        expect(caught).toBeInstanceOf(CallModelError)
        expect((caught as InstanceType<typeof CallModelError>).code).toBe('CALL_MODEL_PARSE')
        // Only ONE outer call — no outer retry after a parse failure.
        expect(generateObjectMock).toHaveBeenCalledTimes(1)
    })

    it('throws CALL_MODEL_PARSE up-front when `schema` and `tools` are combined', async () => {
        // Argument-validation guard: generateObject cannot accept a tool
        // set, so combining the two is caller misuse. Helper fails fast
        // before either SDK entry point is called.
        let caught: unknown
        try {
            await callModel({
                model: 'stub-model',
                prompt: 'p',
                tools: { someTool: { shape: 'any' } },
                schema: TestSchema,
            })
            throw new Error('should have thrown')
        } catch (e) { caught = e }

        expect(caught).toBeInstanceOf(CallModelError)
        expect((caught as InstanceType<typeof CallModelError>).code).toBe('CALL_MODEL_PARSE')
        expect((caught as Error).message).toMatch(/cannot combine `schema` and `tools`/)
        // Neither SDK entry point was called — failed in arg-validation.
        expect(generateTextMock).not.toHaveBeenCalled()
        expect(generateObjectMock).not.toHaveBeenCalled()
    })
})

// ── Phase I Stage 2 — generateObjectWithRepair (C5) ───────────────────

describe('callModel — schema repair + fall-through (C5)', () => {
    const RepairSchema = z.object({
        score: z.number(),
        reason: z.string(),
    })

    it('happy path: model returns valid JSON via generateObject — no repair triggered', async () => {
        generateObjectMock.mockResolvedValueOnce({
            object: { score: 0.7, reason: 'fine' },
            usage: { inputTokens: 5, outputTokens: 3 },
        })

        const result = await callModel({
            model: 'stub-model',
            prompt: 'judge',
            schema: RepairSchema,
        })

        expect(result.object).toEqual({ score: 0.7, reason: 'fine' })
        expect(generateTextMock).not.toHaveBeenCalled()
        expect(generateObjectMock).toHaveBeenCalledTimes(1)
    })

    it('schema-capability error on first attempt → repair via generateText succeeds', async () => {
        // First attempt: provider rejects json_schema mode.
        generateObjectMock.mockRejectedValueOnce(
            Object.assign(new Error('Model does not support response_format json_schema'), {}),
        )
        // Repair attempt: generateText returns clean JSON.
        generateTextMock.mockResolvedValueOnce({
            text: '{"score": 0.42, "reason": "repaired"}',
            usage: { inputTokens: 8, outputTokens: 4 },
        })

        const result = await callModel({
            model: 'stub-model',
            prompt: 'judge this',
            schema: RepairSchema,
        })

        expect(result.object).toEqual({ score: 0.42, reason: 'repaired' })
        expect(result.text).toBe('') // schema-mode contract: text is always empty
        expect(generateObjectMock).toHaveBeenCalledTimes(1)
        expect(generateTextMock).toHaveBeenCalledTimes(1)

        // Repair prompt must include the JSON-only instruction appended to the original prompt
        const repairArg = generateTextMock.mock.calls[0]![0]
        expect(repairArg.prompt).toMatch(/judge this/)
        expect(repairArg.prompt).toMatch(/Respond with ONLY a JSON object/)
        expect(repairArg.model).toBe('stub-model') // SAME model — C5 retry-same-model
    })

    it('repair handles fenced JSON in generateText output', async () => {
        generateObjectMock.mockRejectedValueOnce(new FakeNoObjectGeneratedError('parse failure'))
        generateTextMock.mockResolvedValueOnce({
            text: '```json\n{"score": 0.9, "reason": "fenced ok"}\n```',
            usage: { inputTokens: 6, outputTokens: 4 },
        })

        const result = await callModel({
            model: 'stub-model',
            prompt: 'p',
            schema: RepairSchema,
        })
        expect(result.object).toEqual({ score: 0.9, reason: 'fenced ok' })
    })

    it('two consecutive schema-capability errors with NO fallbackChain → throws CALL_MODEL_PARSE', async () => {
        // First attempt: schema-capability error from generateObject.
        generateObjectMock.mockRejectedValueOnce(
            Object.assign(new Error('json_schema not supported by this provider'), {}),
        )
        // Repair attempt: generateText returns garbage that doesn't parse as JSON.
        generateTextMock.mockResolvedValueOnce({
            text: 'I cannot produce JSON. Sorry.',
            usage: { inputTokens: 4, outputTokens: 6 },
        })

        let caught: unknown
        try {
            await callModel({
                model: 'stub-model',
                prompt: 'judge',
                schema: RepairSchema,
            })
            throw new Error('should have thrown')
        } catch (e) { caught = e }

        expect(caught).toBeInstanceOf(CallModelError)
        expect((caught as InstanceType<typeof CallModelError>).code).toBe('CALL_MODEL_PARSE')
        expect(generateObjectMock).toHaveBeenCalledTimes(1)
        expect(generateTextMock).toHaveBeenCalledTimes(1)
    })

    it('two consecutive schema-capability errors WITH fallbackChain → falls through to next model and succeeds', async () => {
        // Model A: native fails, repair fails (text doesn't parse as JSON).
        generateObjectMock.mockRejectedValueOnce(
            Object.assign(new Error('Model A: json_schema not supported'), {}),
        )
        generateTextMock.mockResolvedValueOnce({
            text: 'Model A apologizes; will not produce JSON.',
            usage: { inputTokens: 1, outputTokens: 2 },
        })
        // Model B: native generateObject succeeds.
        generateObjectMock.mockResolvedValueOnce({
            object: { score: 1.0, reason: 'model-B' },
            usage: { inputTokens: 7, outputTokens: 4 },
        })

        const result = await callModel({
            model: 'model-A',
            prompt: 'judge',
            schema: RepairSchema,
            fallbackChain: ['model-B'],
        })

        expect(result.object).toEqual({ score: 1.0, reason: 'model-B' })
        // Model A: 1 generateObject + 1 generateText repair = 2 calls
        // Model B: 1 generateObject = 1 call
        expect(generateObjectMock).toHaveBeenCalledTimes(2)
        expect(generateTextMock).toHaveBeenCalledTimes(1)

        // The second generateObject call must have been issued against model B
        const secondGenObj = generateObjectMock.mock.calls[1]![0]
        expect(secondGenObj.model).toBe('model-B')
    })

    it('non-schema error (network 5xx) propagates immediately — no repair attempted', async () => {
        // Schema-mode generateObject hits a 503; isSchemaCapabilityError is
        // false, so the wrapper does NOT enter repair path. The outer retry
        // loop kicks in (transient retry on 5xx), then on the second 5xx it
        // throws CALL_MODEL_5XX. generateText must NEVER have been called.
        const err503 = Object.assign(new Error('upstream unavailable'), { status: 503 })
        generateObjectMock.mockRejectedValueOnce(err503).mockRejectedValueOnce(err503)

        let caught: unknown
        try {
            await callModel({
                model: 'stub-model',
                prompt: 'p',
                schema: RepairSchema,
            })
            throw new Error('should have thrown')
        } catch (e) { caught = e }

        expect(caught).toBeInstanceOf(CallModelError)
        expect((caught as InstanceType<typeof CallModelError>).code).toBe('CALL_MODEL_5XX')
        expect(generateTextMock).not.toHaveBeenCalled()
        // Outer transient-retry loop hit generateObject twice
        expect(generateObjectMock).toHaveBeenCalledTimes(2)
    })
})

// ── PLEXO_LLM_STUB ────────────────────────────────────────────────────
// Phase K — deterministic stub mode for e2e tests.

describe('callModel — PLEXO_LLM_STUB stub mode', () => {
    const ORIG_STUB = process.env.PLEXO_LLM_STUB

    beforeEach(() => {
        process.env.PLEXO_LLM_STUB = 'true'
    })

    afterEach(() => {
        if (ORIG_STUB === undefined) delete process.env.PLEXO_LLM_STUB
        else process.env.PLEXO_LLM_STUB = ORIG_STUB
    })

    it('text mode + planning + multi-step prompt returns 3-step plan with OWD', async () => {
        const result = await callModel({
            model: 'stub-model',
            prompt: 'Push my code to the test branch and run the full test suite, then open a pull request.',
            taskType: 'planning',
        })
        const plan = JSON.parse(result.text) as {
            type: string
            steps: { stepNumber: number }[]
            oneWayDoors: { requiresApproval?: boolean }[]
        }
        expect(plan.type).toBe('plan')
        expect(plan.steps.length).toBe(3)
        expect(plan.oneWayDoors.length).toBe(1)
        expect(plan.oneWayDoors[0]!.requiresApproval).toBe(true)
        // Real generateText / generateObject must NOT have been called.
        expect(generateTextMock).not.toHaveBeenCalled()
        expect(generateObjectMock).not.toHaveBeenCalled()
    })

    it('text mode + planning + trivial prompt returns 1-step plan with no OWD', async () => {
        const result = await callModel({
            model: 'stub-model',
            prompt: 'What time is it?',
            taskType: 'planning',
        })
        const plan = JSON.parse(result.text) as {
            steps: unknown[]
            oneWayDoors: unknown[]
        }
        expect(plan.steps.length).toBe(1)
        expect(plan.oneWayDoors.length).toBe(0)
    })

    it('schema mode with judgment-shaped schema returns canned judgment', async () => {
        const JudgmentSchema = z.object({
            scores: z.array(z.object({
                dimension: z.string(),
                score: z.number().min(0).max(1),
                rationale: z.string(),
            })),
            overall_notes: z.string(),
        })
        const result = await callModel({
            model: 'stub-model',
            prompt: 'judge this',
            taskType: 'judging',
            schema: JudgmentSchema,
        })
        expect(result.object.scores.length).toBeGreaterThan(0)
        expect(typeof result.object.overall_notes).toBe('string')
        expect(generateObjectMock).not.toHaveBeenCalled()
    })

    it('schema mode with unknown schema throws clear stub-does-not-know error', async () => {
        const ExoticSchema = z.object({ foo: z.literal('exotic'), bar: z.number() })
        let caught: unknown
        try {
            await callModel({
                model: 'stub-model',
                prompt: 'p',
                taskType: 'exotic',
                schema: ExoticSchema,
            })
        } catch (e) { caught = e }
        expect(caught).toBeInstanceOf(CallModelError)
        expect((caught as Error).message).toMatch(/stub does not know/i)
    })

    it('text mode + non-planning task returns generic stub text', async () => {
        const result = await callModel({
            model: 'stub-model',
            prompt: 'hello',
            taskType: 'chat',
        })
        expect(result.text).toContain('[STUB]')
        expect(generateTextMock).not.toHaveBeenCalled()
    })
})

describe('callModel — schema_relaxed telemetry counter', () => {
    const S = z.object({ score: z.number(), reason: z.string() })

    it('starts at zero', () => {
        expect(getSchemaRelaxedStats()).toEqual({
            fenceRescue: 0, repairArrayWrap: 0, repairRekey: 0, repairValidated: 0, total: 0,
        })
    })

    it('does NOT increment on a clean native generateObject success', async () => {
        generateObjectMock.mockResolvedValueOnce({ object: { score: 1, reason: 'ok' } })
        await callModel({ model: 'm', prompt: 'p', schema: S })
        expect(getSchemaRelaxedStats().total).toBe(0)
    })

    it('increments fenceRescue when fenced JSON is rescued from a generateObject failure', async () => {
        generateObjectMock.mockRejectedValueOnce(
            Object.assign(new FakeNoObjectGeneratedError('parse'), { text: '```json\n{"score":0.5,"reason":"r"}\n```' }),
        )
        const r = await callModel({ model: 'm', prompt: 'p', schema: S })
        expect(r.object).toEqual({ score: 0.5, reason: 'r' })
        const s = getSchemaRelaxedStats()
        expect(s.fenceRescue).toBe(1)
        expect(s.total).toBe(1)
    })

    it('increments repairValidated when same-model generateText repair output validates', async () => {
        generateObjectMock.mockRejectedValueOnce(new Error('Model does not support response_format json_schema'))
        generateTextMock.mockResolvedValueOnce({ text: '{"score":0.3,"reason":"repaired"}' })
        await callModel({ model: 'm', prompt: 'p', schema: S })
        const s = getSchemaRelaxedStats()
        expect(s.repairValidated).toBe(1)
        expect(s.total).toBe(1)
    })
})
