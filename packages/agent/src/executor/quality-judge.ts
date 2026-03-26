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
import { generateText } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import pino from 'pino'
import { QUALITY_RUBRICS, MODEL_ROUTING } from '../constants.js'
import { resolveModelFromEnv, resolveModel } from '../providers/registry.js'
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
    const textResult = await generateText({
        model, system,
        prompt: prompt + '\n\nRespond with ONLY valid JSON matching the schema: { "scores": [{ "dimension": string, "score": number, "rationale": string }], "overall_notes": string }',
        abortSignal: AbortSignal.timeout(30_000),
    })
    const cleaned = textResult.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
    const judgment = JudgmentSchema.parse(JSON.parse(cleaned))
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
                const textResult = await generateText({
                    model, system,
                    prompt: prompt + '\n\nRespond with ONLY valid JSON matching the schema: { "scores": [{ "dimension": string, "score": number, "rationale": string }], "overall_notes": string }',
                    abortSignal: AbortSignal.timeout(30_000),
                })
                const cleaned = textResult.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
                const judgment = JudgmentSchema.parse(JSON.parse(cleaned))
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

// ── Public entry point ────────────────────────────────────────────────────────

export async function judgeQuality(params: JudgeParams): Promise<JudgeResult> {
    const { taskType, selfScore, aiSettings } = params
    const rubric = QUALITY_RUBRICS[taskType as TaskType] ?? QUALITY_RUBRICS.coding

    // Resolve workspace-configurable parameters, with safe defaults.
    const ensembleSize = Math.max(1, Math.min(5, aiSettings?.ensembleSize ?? DEFAULT_ENSEMBLE_SIZE))
    const dissentThreshold = Math.max(0, Math.min(1, aiSettings?.dissentThreshold ?? DEFAULT_DISSENT_THRESHOLD))

    const fallback: JudgeResult = {
        score: selfScore,
        meta: { mode: 'fallback', selfScore, judgeCount: 0, dissenters: [], models: [] },
    }

    try {
        const ollamaBase = aiSettings?.providers?.ollama?.baseUrl

        if (ollamaBase) {
            logger.info({ baseUrl: ollamaBase, ensembleSize, dissentThreshold }, 'Attempting ensemble via configured Ollama')
            try {
                const models = await discoverOllamaModels(ollamaBase, ensembleSize)

                if (models.length > 0) {
                    const { score: ensembleScore, dissenters, models: usedModels, verdicts } =
                        await runEnsemble(params, rubric, ollamaBase, models, dissentThreshold)

                    // Async reliability feedback — fire-and-forget, never blocks the score path.
                    void updateReliabilityScores(verdicts, ensembleScore, dissenters)

                    if (dissenters.length > 0) {
                        logger.info({ dissenters, ensembleMean: ensembleScore.toFixed(3) }, 'Dissent detected — cloud arbitration')
                        try {
                            const arbitrator = aiSettings
                                ? (await resolveModel('summarization', aiSettings).catch(() => ({ model: resolveModelFromEnv(MODEL_ROUTING.summarization), meta: null }))).model
                                : resolveModelFromEnv(MODEL_ROUTING.summarization)
                            const arbitratedScore = await runSingleJudge(params, rubric, arbitrator)
                            const finalScore = Math.min(1, Math.max(0, (ensembleScore + arbitratedScore) / 2))
                            return {
                                score: finalScore,
                                meta: {
                                    mode: 'ensemble+arbitration',
                                    selfScore,
                                    judgeCount: usedModels.length + 1,
                                    dissenters,
                                    models: [...usedModels, 'cloud-arbitrator'],
                                },
                            }
                        } catch (arbErr) {
                            logger.warn({ arbErr }, 'Arbitration failed — using ensemble mean')
                            return {
                                score: Math.min(1, Math.max(0, ensembleScore)),
                                meta: { mode: 'ensemble', selfScore, judgeCount: usedModels.length, dissenters, models: usedModels },
                            }
                        }
                    }

                    logger.info({ ensembleMean: ensembleScore.toFixed(3), selfScore: selfScore.toFixed(3) }, 'Ensemble done (no dissent)')
                    return {
                        score: Math.min(1, Math.max(0, ensembleScore)),
                        meta: { mode: 'ensemble', selfScore, judgeCount: usedModels.length, dissenters: [], models: usedModels },
                    }
                }

                logger.info({ baseUrl: ollamaBase }, 'No Ollama models found — falling back to single judge')
            } catch (ensembleErr) {
                logger.warn({ ensembleErr }, 'Ensemble failed — falling back to single judge')
            }
        }

        // Single judge — cross-model enforcement: judge must use a different
        // provider tier than the executor to prevent self-evaluation bias.
        // If primary is Anthropic → judge uses OpenAI/OpenRouter class.
        // If primary is OpenAI/other → judge uses Anthropic class.
        let singleModel: Awaited<ReturnType<typeof resolveModel>>['model']
        if (aiSettings) {
            const primary = aiSettings.primaryProvider ?? ''
            const isAnthropicPrimary = primary === 'anthropic'
            // Try cross-provider first, fall back to same-provider summarization tier
            const crossProviderKey = isAnthropicPrimary
                ? (['openai', 'openrouter', 'groq'] as const).find(k => aiSettings.providers[k]?.apiKey)
                : (['anthropic'] as const).find(k => aiSettings.providers[k]?.apiKey)
            if (crossProviderKey) {
                const crossSettings: WorkspaceAISettings = {
                    ...aiSettings,
                    primaryProvider: crossProviderKey as any,
                    fallbackChain: [],
                }
                singleModel = (await resolveModel('summarization', crossSettings).catch(() =>
                    ({ model: resolveModelFromEnv(MODEL_ROUTING.summarization), meta: null })
                )).model
                logger.info({ primary, judgeProvider: crossProviderKey }, 'Cross-model judge: using different provider')
            } else {
                // No cross-provider available — fall back to same provider
                singleModel = (await resolveModel('summarization', aiSettings).catch(() =>
                    ({ model: resolveModelFromEnv(MODEL_ROUTING.summarization), meta: null })
                )).model
            }
        } else {
            singleModel = resolveModelFromEnv(MODEL_ROUTING.summarization)
        }
        const score = Math.min(1, Math.max(0, await runSingleJudge(params, rubric, singleModel)))
        logger.info({ taskType, score: score.toFixed(3), selfScore: selfScore.toFixed(3) }, 'Single judge done')
        return {
            score,
            meta: { mode: 'single', selfScore, judgeCount: 1, dissenters: [], models: ['cloud'] },
        }
    } catch (err) {
        logger.warn({ err }, 'Quality judge failed — self-score passthrough')
        return fallback
    }
}
