/**
 * Independent quality judge — decoupled from the task executor.
 *
 * Two modes:
 *   1. Ensemble: If the workspace has an active Ollama provider configured (local or remote),
 *      runs N parallel local-model judges and aggregates via weighted consensus.
 *      A cloud model arbitrates if judges diverge by > DISSENT_THRESHOLD.
 *
 *   2. Single-judge (fallback): Uses a single cheap cloud model (haiku or equivalent).
 *      Active when Ollama is not configured or model discovery fails.
 *
 * Returns a JudgeResult with the composite score AND metadata (mode, judgeCount, dissenters,
 * selfScore) so the UI can surface the full picture. Never a hard dependency — falls back
 * to the agent's self-reported score on any unhandled failure.
 */
import { generateObject } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { z } from 'zod'
import pino from 'pino'
import { QUALITY_RUBRICS, MODEL_ROUTING } from '../constants.js'
import { resolveModelFromEnv } from '../providers/registry.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { db, eq } from '@plexo/db'
import { modelsKnowledge } from '@plexo/db'

const logger = pino({ name: 'quality-judge' })

// ── Constants ─────────────────────────────────────────────────────────────────

/** Max ensemble participants recruited from the Ollama instance. */
const ENSEMBLE_SIZE = 3

/** Score deviation from ensemble mean that triggers cloud arbitration. */
const DISSENT_THRESHOLD = 0.25

/** Preferred small models, tried in priority order when populating the ensemble. */
const PREFERRED_LOCAL_MODELS = [
    'llama3.2', 'llama3.1', 'phi3', 'phi3.5', 'gemma2', 'gemma3',
    'mistral', 'qwen2.5', 'deepseek-r1', 'llava',
]

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
    /** Model IDs that diverged from consensus by > DISSENT_THRESHOLD. */
    dissenters: string[]
    /** All model IDs that responded (for display in the UI). */
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

/**
 * Discover available models from a remote (or local) Ollama instance.
 * Accepts any form of baseUrl: http://host:11434, http://host:11434/v1, etc.
 */
async function discoverOllamaModels(baseUrl: string): Promise<string[]> {
    const root = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    const resp = await fetch(`${root}/api/tags`, { signal: AbortSignal.timeout(4_000) })
    if (!resp.ok) return []
    const data = await resp.json() as OllamaTagsResponse
    const allModels = data.models ?? []

    const selected: string[] = []
    for (const preferred of PREFERRED_LOCAL_MODELS) {
        const match = allModels.find((m) => m.name.startsWith(preferred))
        if (match && !selected.includes(match.name)) selected.push(match.name)
        if (selected.length >= ENSEMBLE_SIZE) break
    }
    for (const m of allModels) {
        if (selected.length >= ENSEMBLE_SIZE) break
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
        // Default 1.0 — equal footing until the track record accumulates.
        return row?.score ?? 1.0
    } catch {
        return 1.0
    }
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
    const result = await generateObject({ model, schema: JudgmentSchema, system, prompt, maxOutputTokens: 512 })
    return computeWeightedScore(result.object, rubric, params.selfScore)
}

// ── Ensemble (N parallel calls) ───────────────────────────────────────────────

async function runEnsemble(
    params: JudgeParams,
    rubric: typeof QUALITY_RUBRICS[keyof typeof QUALITY_RUBRICS],
    baseUrl: string,
    modelNames: string[],
): Promise<{ score: number; dissenters: string[]; models: string[] }> {
    const { system, prompt } = buildJudgePrompt(params, rubric)
    // Normalise to /v1 — works for local and remote Ollama instances alike.
    const olBase = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1'
    const ol = createOpenAICompatible({ name: 'ollama-ensemble', baseURL: olBase })

    const verdicts = await Promise.all(
        modelNames.map(async (name): Promise<VerdictResult | null> => {
            try {
                const model = ol(name)
                const result = await generateObject({ model, schema: JudgmentSchema, system, prompt, maxOutputTokens: 512 })
                const score = computeWeightedScore(result.object, rubric, params.selfScore)
                const weight = await getModelWeight(name)
                logger.debug({ model: name, score: score.toFixed(3), weight }, 'Ensemble verdict')
                return { modelId: name, score, weight }
            } catch (err) {
                logger.warn({ err, model: name }, 'Ensemble judge skipped')
                return null
            }
        }),
    )

    const valid = verdicts.filter((v): v is VerdictResult => v !== null)
    if (valid.length === 0) throw new Error('All ensemble judges failed')

    const totalWeight = valid.reduce((s, v) => s + v.weight, 0)
    const weightedMean = valid.reduce((s, v) => s + v.score * v.weight, 0) / totalWeight
    const dissenters = valid
        .filter((v) => Math.abs(v.score - weightedMean) > DISSENT_THRESHOLD)
        .map((v) => v.modelId)

    logger.info({ judges: valid.length, weightedMean: weightedMean.toFixed(3), dissenters }, 'Ensemble consensus')
    return { score: weightedMean, dissenters, models: valid.map((v) => v.modelId) }
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function judgeQuality(params: JudgeParams): Promise<JudgeResult> {
    const { taskType, selfScore, aiSettings } = params
    const rubric = QUALITY_RUBRICS[taskType as TaskType] ?? QUALITY_RUBRICS.coding

    const fallback: JudgeResult = {
        score: selfScore,
        meta: { mode: 'fallback', selfScore, judgeCount: 0, dissenters: [], models: [] },
    }

    try {
        const ollamaBase = aiSettings?.providers?.ollama?.baseUrl

        if (ollamaBase) {
            logger.info({ baseUrl: ollamaBase }, 'Attempting ensemble via configured Ollama')
            try {
                const models = await discoverOllamaModels(ollamaBase)

                if (models.length > 0) {
                    const { score: ensembleScore, dissenters, models: usedModels } =
                        await runEnsemble(params, rubric, ollamaBase, models)

                    if (dissenters.length > 0) {
                        logger.info({ dissenters, ensembleMean: ensembleScore.toFixed(3) }, 'Dissent detected — cloud arbitration')
                        try {
                            const arbitrator = resolveModelFromEnv(MODEL_ROUTING.summarization)
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

        // Single judge
        const model = resolveModelFromEnv(MODEL_ROUTING.summarization)
        const score = Math.min(1, Math.max(0, await runSingleJudge(params, rubric, model)))
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
