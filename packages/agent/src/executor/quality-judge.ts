// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Independent quality judge — decoupled from the task executor.
 *
 * Two modes:
 *   1. Ensemble: If the workspace has an active Ollama provider configured (local or remote),
 *      runs N parallel local-model judges and aggregates via weighted consensus.
 *      A cloud model arbitrates if judges diverge by > dissentThreshold.
 *
 *   2. Single-judge (fallback): Uses a single cheap cloud model (haiku or equivalent).
 *      Active when Ollama is not configured or model discovery fails.
 *
 * After each ensemble run, each judge's reliabilityScore is nudged:
 *   - Agrees with consensus (within 0.1)  → +0.005 (slow, positive drift)
 *   - Dissents from consensus             → -0.01  (penalised, but floored at 0.1)
 * This creates a self-calibrating system: consistently-accurate models get more weight.
 *
 * Returns a JudgeResult with the composite score AND metadata (mode, judgeCount, dissenters,
 * selfScore) so the UI can surface the full picture. Never a hard dependency — falls back
 * to the agent's self-reported score on any unhandled failure.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import pino from 'pino'
import { QUALITY_RUBRICS, MODEL_ROUTING } from '../constants.js'
import { resolveModelFromEnv, resolveModel, buildModel } from '../providers/registry.js'
import type { ProviderKey } from '../providers/registry.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { db, eq, sql } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'

const logger = pino({ name: 'quality-judge' })

// ── Default constants (overridable via WorkspaceAISettings) ───────────────────

const DEFAULT_ENSEMBLE_SIZE = 3
const DEFAULT_DISSENT_THRESHOLD = 0.25

/** Preferred small models, tried in priority order when populating the ensemble. */
const PREFERRED_LOCAL_MODELS = [
    'llama3.2', 'llama3.1', 'phi3', 'phi3.5', 'gemma2', 'gemma3',
    'mistral', 'qwen2.5', 'deepseek-r1', 'llava',
]

/**
 * Curated list of models that reliably produce JSON-schema output for the
 * quality judge, ordered by closeness to Anthropic Claude Haiku (cheap +
 * strict structured output). Used as fallback candidates when the workspace
 * has no explicit `judgeModel` pin, OR when the pinned model fails. We only
 * use a candidate the workspace already has keyed — never force a provider.
 */
const RECOMMENDED_JUDGE_MODELS: Array<{ provider: ProviderKey; model: string }> = [
    { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    { provider: 'openai', model: 'gpt-4o-mini' },
    { provider: 'google', model: 'gemini-2.5-flash' },
    { provider: 'mistral', model: 'mistral-small-latest' },
    { provider: 'cohere', model: 'command-r-08-2024' },
]

// ── Reliability nudge constants ───────────────────────────────────────────────

/** Score delta within which a judge is considered to agree with consensus. */
const AGREEMENT_WINDOW = 0.1
/** Reliability bump when a judge agrees. */
const RELIABILITY_AGREE_DELTA = 0.005
/** Reliability penalty when a judge dissents. */
const RELIABILITY_DISSENT_DELTA = -0.01
/** Floor so no model gets completely zeroed out. */
const RELIABILITY_FLOOR = 0.1
/** Ceiling. */
const RELIABILITY_CEIL = 2.0

// ── Schemas ────────────────────────────────────────────────────────────────────

const DimensionScoreSchema = z.object({
    dimension: z.string(),
    score: z.number().min(0).max(1),
    rationale: z.string(),
})

const JudgmentSchema = z.object({
    scores: z.array(DimensionScoreSchema),
    overall_notes: z.string(),
})

// ── Public types ───────────────────────────────────────────────────────────────

export type JudgeMode = 'ensemble' | 'ensemble+arbitration' | 'single' | 'fallback'

export interface JudgeMeta {
    mode: JudgeMode
    selfScore: number
    /** Total judge invocations that contributed to the score. */
    judgeCount: number
    /** Model IDs that diverged from consensus by > dissentThreshold. */
    dissenters: string[]
    /** All model IDs that responded. */
    models: string[]
}

export interface JudgeResult {
    score: number
    meta: JudgeMeta
}

// ── Internal types ─────────────────────────────────────────────────────────────

type TaskType = keyof typeof QUALITY_RUBRICS

type JudgeParams = {
    taskType: string
    goal: string
    deliverableSummary: string
    toolsUsed: string[]
    selfScore: number
    aiSettings?: WorkspaceAISettings
    /**
     * Phase: side-effect verification. When the user asked the agent to
     * create/update/send/modify something via a connected service, we check
     * whether the agent actually invoked a matching tool. If it only described
     * the action in text (e.g. "I will create a Notion page") without calling
     * any `namespace__*` tool, the quality score is penalised heavily.
     */
    userRequest?: string
}

type VerdictResult = { modelId: string; score: number; weight: number }

// ── Ollama model discovery ────────────────────────────────────────────────────

interface OllamaTagsResponse {
    models: Array<{ name: string }>
}

async function discoverOllamaModels(baseUrl: string, ensembleSize: number): Promise<string[]> {
    const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    const resp = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(4_000) })
    if (!resp.ok) return []
    const data = await resp.json() as OllamaTagsResponse
    const allModels = data.models ?? []

    const selected: string[] = []
    for (const preferred of PREFERRED_LOCAL_MODELS) {
        const match = allModels.find((m) => m.name.startsWith(preferred))
        if (match && !selected.includes(match.name)) selected.push(match.name)
        if (selected.length >= ensembleSize) break
    }
    for (const m of allModels) {
        if (selected.length >= ensembleSize) break
        if (!selected.includes(m.name)) selected.push(m.name)
    }

    logger.info({ root, available: allModels.length, selected }, 'Ollama ensemble candidates')
    return selected
}

// ── Per-model reliability weights ─────────────────────────────────────────────

async function getModelWeight(modelId: string): Promise<number> {
    try {
        const baseId = modelId.split(':')[0] ?? modelId
        const [row] = await db.select({ score: modelsKnowledge.reliabilityScore })
            .from(modelsKnowledge)
            .where(eq(modelsKnowledge.modelId, baseId))
            .limit(1)
        return row?.score ?? 1.0
    } catch {
        return 1.0
    }
}

// ── Reliability feedback update ───────────────────────────────────────────────

/**
 * Nudge each participating model's reliabilityScore based on whether it agreed
 * or dissented from the ensemble consensus. Uses a small EMA-style adjustment
 * to avoid sudden swings from any single task.
 */
async function updateReliabilityScores(
    verdicts: VerdictResult[],
    consensus: number,
    dissenters: string[],
): Promise<void> {
    await Promise.allSettled(
        verdicts.map(async (v) => {
            const baseId = v.modelId.split(':')[0] ?? v.modelId
            const dissented = dissenters.includes(v.modelId)
            const delta = dissented ? RELIABILITY_DISSENT_DELTA : RELIABILITY_AGREE_DELTA
            try {
                await db.execute(sql`
                    UPDATE models_knowledge
                    SET reliability_score = GREATEST(
                        ${RELIABILITY_FLOOR},
                        LEAST(${RELIABILITY_CEIL}, reliability_score + ${delta})
                    )
                    WHERE model_id = ${baseId}
                `)
                logger.debug({ model: baseId, delta, consensus: consensus.toFixed(3), dissented }, 'Reliability score nudged')
            } catch (err) {
                logger.warn({ err, model: baseId }, 'Failed to update reliability score — skipping')
            }
        })
    )
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildJudgePrompt(
    params: JudgeParams,
    rubric: typeof QUALITY_RUBRICS[keyof typeof QUALITY_RUBRICS],
) {
    const dimensionList = rubric
        .map((d) => `- ${d.dimension} (weight: ${(d.weight * 100).toFixed(0)}%)`)
        .join('\n')

    return {
        system: `You are an independent quality evaluator for AI agent tasks.
Score each dimension 0.0–1.0 based on the evidence provided. Apply strict, evidence-based scoring.
Do NOT simply validate the agent's self-assessment — you are a separate, impartial judge.`,
        prompt: `Task goal: ${params.goal}

Task type: ${params.taskType}
Tools used: ${params.toolsUsed.join(', ')}
Agent self-score: ${params.selfScore.toFixed(2)} (for reference only — form your own judgment)

Deliverable summary:
${params.deliverableSummary.slice(0, 2000)}

Score each of these quality dimensions:
${dimensionList}

Provide a score (0.0–1.0) and one-sentence rationale for each dimension.`,
    }
}

// ── Weighted score computation ────────────────────────────────────────────────

function computeWeightedScore(
    judgment: z.infer<typeof JudgmentSchema>,
    rubric: typeof QUALITY_RUBRICS[keyof typeof QUALITY_RUBRICS],
    selfScore: number,
): number {
    let weightedSum = 0
    let totalWeight = 0
    for (const rubricDim of rubric) {
        const judged = judgment.scores.find((s) => s.dimension === rubricDim.dimension)
        if (judged) {
            weightedSum += judged.score * rubricDim.weight
            totalWeight += rubricDim.weight
        }
    }
    return totalWeight > 0 ? weightedSum / totalWeight : selfScore
}

// ── Single model call ─────────────────────────────────────────────────────────

async function runSingleJudge(
    params: JudgeParams,
    rubric: typeof QUALITY_RUBRICS[keyof typeof QUALITY_RUBRICS],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: any,
): Promise<number> {
    const { system, prompt } = buildJudgePrompt(params, rubric)
    // Phase 4 hardening — callModel routes through `generateObject` with
    // the Zod schema when `schema` is provided. The SDK owns the parse +
    // retry-on-malformed-output loop (maxRetries: 2 internally); callModel
    // adds abort composition, typed error codes (CALL_MODEL_PARSE on
    // persistent malformed output), and the 30s step timeout.
    const { callModel } = await import('../providers/call-model.js')
    const { object: judgment } = await callModel({
        model,
        system,
        prompt,
        schema: JudgmentSchema,
        schemaName: 'JudgeVerdict',
        schemaDescription: 'A quality-judge verdict: per-dimension scores plus overall notes.',
        stepTimeoutMs: 30_000,
        taskType: params.taskType,
    })
    return computeWeightedScore(judgment, rubric, params.selfScore)
}

// ── Ollama resilient fetch ────────────────────────────────────────────────
//
// Many reverse proxies (nginx/openresty) configured for Ollama only allow
// POST on /api/* paths but return 405 Method Not Allowed on the OpenAI-
// compatible /v1/chat/completions path.  This wrapper intercepts 405s and
// transparently retries against the native Ollama /api/chat endpoint,
// translating the OpenAI request body ↔ Ollama native format on the fly.

function ollamaResilientFetch(ollamaRoot: string): typeof globalThis.fetch {
    return async (input, init) => {
        const resp = await globalThis.fetch(input, init)
        if (resp.status !== 405) return resp

        // Only retry chat/completions requests
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
        if (!url.includes('/chat/completions')) return resp

        // Translate OpenAI body → Ollama native format
        let body: Record<string, unknown> | undefined
        try {
            const raw = init?.body
            body = raw ? JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer)) : undefined
        } catch { return resp }
        if (!body) return resp

        const nativeBody = {
            model: body.model,
            messages: body.messages,
            stream: false,
            options: {
                ...(body.temperature != null && { temperature: body.temperature }),
                ...(body.top_p != null && { top_p: body.top_p }),
            },
        }

        logger.debug({ url, nativeUrl: `${ollamaRoot}/api/chat` }, '405 on /v1/chat/completions — retrying via native /api/chat')
        const nativeResp = await globalThis.fetch(`${ollamaRoot}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(nativeBody),
            signal: init?.signal as AbortSignal | undefined,
        })
        if (!nativeResp.ok) return nativeResp

        // Translate Ollama native response → OpenAI format so the SDK can parse it
        const nativeData = await nativeResp.json() as {
            message?: { role?: string; content?: string }
            model?: string
        }
        const openAIBody = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            model: nativeData.model ?? body.model,
            choices: [{
                index: 0,
                message: {
                    role: nativeData.message?.role ?? 'assistant',
                    content: nativeData.message?.content ?? '',
                },
                finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }

        return new Response(JSON.stringify(openAIBody), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
}

// ── Ensemble (N parallel calls) ───────────────────────────────────────────────

async function runEnsemble(
    params: JudgeParams,
    rubric: typeof QUALITY_RUBRICS[keyof typeof QUALITY_RUBRICS],
    baseUrl: string,
    modelNames: string[],
    dissentThreshold: number,
): Promise<{ score: number; dissenters: string[]; models: string[]; verdicts: VerdictResult[] }> {
    const { system, prompt } = buildJudgePrompt(params, rubric)
    // Normalise to /v1 — works for local and remote Ollama instances alike.
    // Use a resilient fetch wrapper that falls back to the native Ollama API
    // (/api/chat) when the reverse proxy returns 405 on /v1/chat/completions.
    const olRoot = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '').replace(/\/api$/, '')
    const olBase = olRoot + '/v1'
    const ol = createOpenAICompatible({
        name: 'ollama-ensemble',
        baseURL: olBase,
        fetch: ollamaResilientFetch(olRoot),
    })

    const raw = await Promise.all(
        modelNames.map(async (name): Promise<VerdictResult | null> => {
            try {
                const model = ol(name)
                // Phase 4 hardening — schema-mode callModel. SDK validates
                // the Zod shape and retries on parse failure before surfacing
                // CALL_MODEL_PARSE. No hand-rolled fence strip / JSON.parse.
                const { callModel } = await import('../providers/call-model.js')
                const { object: judgment } = await callModel({
                    model,
                    system,
                    prompt,
                    schema: JudgmentSchema,
                    schemaName: 'JudgeVerdict',
                    schemaDescription: 'A quality-judge verdict: per-dimension scores plus overall notes.',
                    stepTimeoutMs: 30_000,
                    taskType: params.taskType,
                })
                const score = computeWeightedScore(judgment, rubric, params.selfScore)
                const weight = await getModelWeight(name)
                logger.debug({ model: name, score: score.toFixed(3), weight }, 'Ensemble verdict')
                return { modelId: name, score, weight }
            } catch (err) {
                logger.warn({ err, model: name }, 'Ensemble judge skipped')
                return null
            }
        }),
    )

    const verdicts = raw.filter((v): v is VerdictResult => v !== null)
    if (verdicts.length === 0) throw new Error('All ensemble judges failed')

    const totalWeight = verdicts.reduce((s, v) => s + v.weight, 0)
    const weightedMean = verdicts.reduce((s, v) => s + v.score * v.weight, 0) / totalWeight
    const dissenters = verdicts
        .filter((v) => Math.abs(v.score - weightedMean) > dissentThreshold)
        .map((v) => v.modelId)

    logger.info({ judges: verdicts.length, weightedMean: weightedMean.toFixed(3), dissenters }, 'Ensemble consensus')
    return { score: weightedMean, dissenters, models: verdicts.map((v) => v.modelId), verdicts }
}

// ── Side-effect verification ──────────────────────────────────────────────────
//
// Implemented in a side module so the pure detection logic can be unit-tested
// without pulling in the executor's DB dependency graph.
export { detectSideEffectGap } from './side-effect-check.js'
export type { SideEffectCheck } from './side-effect-check.js'
import { detectSideEffectGap as _detectSideEffectGap, SIDE_EFFECT_PENALTY_CEILING } from './side-effect-check.js'

// ── Public entry point ────────────────────────────────────────────────────────

export async function judgeQuality(params: JudgeParams): Promise<JudgeResult> {
    const { taskType, selfScore, aiSettings } = params
    const rubric = QUALITY_RUBRICS[taskType as TaskType] ?? QUALITY_RUBRICS.coding

    // Side-effect verification: detect when the user asked for a real-world
    // action (create/send/update via a connected service) but the agent did
    // not invoke any matching tool. When penalised, the final score is capped
    // at SIDE_EFFECT_PENALTY_CEILING regardless of what the model judges say.
    const sideEffectCheck = _detectSideEffectGap(
        params.userRequest ?? params.goal ?? '',
        params.deliverableSummary ?? '',
        params.toolsUsed ?? [],
    )
    if (sideEffectCheck.penalised) {
        logger.warn(
            { reason: sideEffectCheck.reason, expected: sideEffectCheck.expectedNamespaces, tools: params.toolsUsed },
            'Side-effect gap detected — quality will be capped',
        )
    }

    const capScore = (s: number): number => {
        if (sideEffectCheck.penalised) return Math.min(s, SIDE_EFFECT_PENALTY_CEILING)
        return s
    }

    const fallback: JudgeResult = {
        score: capScore(selfScore),
        meta: { mode: 'fallback', selfScore, judgeCount: 0, dissenters: [], models: [] },
    }

    // Single-model policy w/ recommended-judge fallback.
    //
    // The judge needs structured-JSON output, which many primary execution
    // models (llama-3.3, deepseek) can't emit reliably. So we try, in order:
    //   1. workspace-pinned judgeModel (WorkspaceAISettings.judgeModel)
    //   2. curated list of JSON-reliable models, filtered by what the
    //      workspace has keyed (so we never force a provider on the user)
    //   3. workspace primary (current behaviour — usually parse-fails to
    //      self-score passthrough)
    //   4. env fallback (resolveModelFromEnv)
    //
    // Each candidate is tried; on a SKIPPABLE error (parse failure, credit
    // depleted, rate-limit, network) we move to the next. Hard errors
    // surface to the outer catch which returns self-score passthrough.
    type JudgeCandidate = { provider: string; model?: string; build: () => unknown }
    const candidates: JudgeCandidate[] = []

    if (aiSettings) {
        // 1. Workspace pin
        if (aiSettings.judgeModel) {
            const { provider, model } = aiSettings.judgeModel
            const cfg = aiSettings.providers[provider]
            candidates.push({
                provider,
                model,
                build: () => buildModel(
                    provider,
                    { provider, apiKey: cfg?.apiKey, baseUrl: cfg?.baseUrl, model },
                    'summarization',
                    aiSettings,
                ),
            })
        }

        // 2. Recommended JSON-reliable models — added only if the workspace
        //    has the provider keyed (apiKey present). Skip duplicates of the pin.
        for (const rec of RECOMMENDED_JUDGE_MODELS) {
            if (aiSettings.judgeModel?.provider === rec.provider && aiSettings.judgeModel?.model === rec.model) continue
            const cfg = aiSettings.providers[rec.provider]
            if (!cfg?.apiKey) continue
            candidates.push({
                provider: rec.provider,
                model: rec.model,
                build: () => buildModel(
                    rec.provider,
                    { provider: rec.provider, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: rec.model },
                    'summarization',
                    aiSettings,
                ),
            })
        }

        // 3. Workspace primary (current behaviour)
        candidates.push({
            provider: aiSettings.primaryProvider,
            build: async () => (await resolveModel('summarization', aiSettings).catch(() =>
                ({ model: resolveModelFromEnv(MODEL_ROUTING.summarization), meta: null })
            )).model,
        })
    }

    // 4. Env fallback — always last
    candidates.push({
        provider: 'env',
        build: () => resolveModelFromEnv(MODEL_ROUTING.summarization),
    })

    // NO_PROVIDER_AVAILABLE is the env-fallback's "no judge provider configured
    // anywhere" verdict. When the workspace primary also skipped (e.g. credit
    // balance low), the cascade ends here. Treat it as skippable so the run
    // returns a quiet passthrough instead of a per-turn warning.
    const skippablePattern = /json_schema|response format|structured|No object generated|JSON parsing failed|credit balance|insufficient_quota|rate.?limit|quota|tpd|429|ENOTFOUND|fetch failed|CALL_MODEL_TIMEOUT|CALL_MODEL_PARSE|NO_PROVIDER_AVAILABLE|ProviderResolutionError/i

    for (const cand of candidates) {
        try {
            const model = await Promise.resolve(cand.build())
            const judgeProvider = cand.model ? `${cand.provider}/${cand.model}` : cand.provider
            const rawScore = Math.min(1, Math.max(0, await runSingleJudge(params, rubric, model)))
            const score = capScore(rawScore)
            logger.info(
                { taskType, score: score.toFixed(3), selfScore: selfScore.toFixed(3), penalised: sideEffectCheck.penalised, judgeProvider },
                'Single judge done',
            )
            return {
                score,
                meta: { mode: 'single', selfScore, judgeCount: 1, dissenters: [], models: [judgeProvider] },
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (skippablePattern.test(msg)) {
                logger.warn(
                    { candidate: cand.model ? `${cand.provider}/${cand.model}` : cand.provider, reason: msg.slice(0, 200) },
                    'Judge candidate skipped — trying next',
                )
                continue
            }
            // Non-skippable: surface
            logger.warn({ err }, 'Quality judge failed — self-score passthrough')
            return fallback
        }
    }

    // Downgraded to debug — when ALL candidates skipped via the pattern above
    // (typically credit-balance-low → no env judge), this is the expected quiet
    // path, not a warning condition. A real failure surfaces from the catch's
    // non-skippable branch (line ~552) and DOES log at warn level there.
    logger.debug('Quality judge: all candidates exhausted — self-score passthrough')
    return fallback
}
