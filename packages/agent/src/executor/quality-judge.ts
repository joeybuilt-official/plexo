/**
 * Independent quality judge — decoupled from the task executor.
 *
 * Evaluates task deliverables against the QUALITY_RUBRICS defined in constants.ts
 * using a separate model invocation (claude-haiku). This prevents the executing
 * agent from gaming its own qualityScore (Goodhart's Law).
 *
 * Returns a weighted composite score in [0, 1]. Falls back to the agent's
 * self-reported score on any failure so it is never a hard dependency.
 */
import { generateObject } from 'ai'
import { z } from 'zod'
import pino from 'pino'
import { QUALITY_RUBRICS, MODEL_ROUTING } from '../constants.js'
import { resolveModelFromEnv } from '../providers/registry.js'

const logger = pino({ name: 'quality-judge' })

type TaskType = keyof typeof QUALITY_RUBRICS

const DimensionScoreSchema = z.object({
    dimension: z.string(),
    score: z.number().min(0).max(1),
    rationale: z.string(),
})

const JudgmentSchema = z.object({
    scores: z.array(DimensionScoreSchema),
    overall_notes: z.string(),
})

export async function judgeQuality(params: {
    taskType: string
    goal: string
    deliverableSummary: string
    toolsUsed: string[]
    selfScore: number
}): Promise<number> {
    const { taskType, goal, deliverableSummary, toolsUsed, selfScore } = params

    // Use rubric for the specific type; fall back to coding rubric as default
    const rubric = QUALITY_RUBRICS[taskType as TaskType] ?? QUALITY_RUBRICS.coding

    try {
        const model = resolveModelFromEnv(MODEL_ROUTING.summarization) // haiku — cheap

        const dimensionList = rubric
            .map((d) => `- ${d.dimension} (weight: ${(d.weight * 100).toFixed(0)}%)`)
            .join('\n')

        const result = await generateObject({
            model,
            schema: JudgmentSchema,
            system: `You are an independent quality evaluator for AI agent tasks. 
Score each dimension 0.0–1.0 based on the evidence provided. Apply strict, evidence-based scoring.
Do NOT simply validate the agent's self-assessment — you are a separate, impartial judge.`,
            prompt: `Task goal: ${goal}

Task type: ${taskType}
Tools used: ${toolsUsed.join(', ')}
Agent self-score: ${selfScore.toFixed(2)} (for reference only — form your own judgment)

Deliverable summary:
${deliverableSummary.slice(0, 2000)}

Score each of these quality dimensions:
${dimensionList}

Provide a score (0.0–1.0) and one-sentence rationale for each dimension.`,
            maxOutputTokens: 512,
        })

        // Weight the scores per rubric definition
        let weightedSum = 0
        let totalWeight = 0

        for (const rubricDim of rubric) {
            const judged = result.object.scores.find(
                (s) => s.dimension === rubricDim.dimension,
            )
            if (judged) {
                weightedSum += judged.score * rubricDim.weight
                totalWeight += rubricDim.weight
            }
        }

        const compositeScore = totalWeight > 0
            ? weightedSum / totalWeight
            : selfScore

        logger.info({
            taskType,
            compositeScore: compositeScore.toFixed(3),
            selfScore: selfScore.toFixed(3),
            delta: (compositeScore - selfScore).toFixed(3),
        }, 'Quality judge complete')

        return Math.min(1, Math.max(0, compositeScore))
    } catch (err) {
        logger.warn({ err }, 'Quality judge failed — falling back to self-score')
        return selfScore
    }
}
