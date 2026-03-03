import { generateObject } from 'ai'
import { z } from 'zod'
import { withFallback } from '../providers/registry.js'
import { SAFETY_LIMITS } from '../constants.js'
import { PlexoError } from '../errors.js'
import type { ExecutionPlan, ExecutionContext, PlanStep, OneWayDoor } from '../types.js'
import type { WorkspaceAISettings } from '../providers/registry.js'

const PLANNER_SYSTEM = `You are Plexo's execution planner. Your job is to analyze a task and produce a detailed, safe, reversible execution plan.

Rules:
- Prefer reversible actions. Flag irreversible ones as one-way doors requiring approval.
- Break work into atomic steps that can be verified independently.
- Be conservative with confidence scores — only give 0.9+ if the path is fully clear.
- Identify all external dependencies, file changes, and potential side effects.
- Steps should be independently verifiable.`

const PlanStepSchema = z.object({
    stepNumber: z.number().int().positive(),
    description: z.string(),
    toolsRequired: z.array(z.string()),
    verificationMethod: z.string(),
    isOneWayDoor: z.boolean(),
})

const OneWayDoorSchema = z.object({
    description: z.string(),
    type: z.enum(['data_write', 'external_call', 'destructive', 'state_change']),
    reversibility: z.string(),
    requiresApproval: z.boolean(),
})

const ExecutionPlanSchema = z.object({
    goal: z.string(),
    steps: z.array(PlanStepSchema).min(1),
    oneWayDoors: z.array(OneWayDoorSchema),
    estimatedDurationMs: z.number().nonnegative(),
    confidenceScore: z.number().min(0).max(1),
    risks: z.array(z.string()),
})

/**
 * Default workspace AI settings — Anthropic via env key, no fallback chain.
 * Used when the workspace has no AI provider config stored (legacy / phase 2 mode).
 */
function defaultSettings(): WorkspaceAISettings {
    return {
        primaryProvider: 'anthropic',
        fallbackChain: [],
        providers: {
            anthropic: { provider: 'anthropic' },
        },
    }
}

export async function planTask(
    ctx: ExecutionContext,
    taskDescription: string,
    taskContext: Record<string, unknown>,
    aiSettings?: WorkspaceAISettings,
): Promise<ExecutionPlan> {
    const settings = aiSettings ?? defaultSettings()

    const userPrompt = JSON.stringify({
        task: taskDescription,
        context: taskContext,
        constraints: {
            maxSteps: SAFETY_LIMITS.MAX_PLAN_STEPS,
            tokenBudget: ctx.tokenBudget,
        },
    })

    const { object: plan } = await withFallback(settings, 'planning', async (model) => {
        return generateObject({
            model,
            system: PLANNER_SYSTEM,
            prompt: userPrompt,
            schema: ExecutionPlanSchema,
        })
    })

    if (plan.steps.length > SAFETY_LIMITS.MAX_PLAN_STEPS) {
        throw new PlexoError(
            `Plan has ${plan.steps.length} steps — exceeds safety limit of ${SAFETY_LIMITS.MAX_PLAN_STEPS}`,
            'PLAN_TOO_LARGE',
            'user',
            400,
        )
    }

    return {
        taskId: ctx.taskId,
        goal: plan.goal,
        steps: plan.steps as PlanStep[],
        oneWayDoors: (plan.oneWayDoors ?? []) as OneWayDoor[],
        estimatedDurationMs: plan.estimatedDurationMs ?? 0,
        confidenceScore: Math.min(1, Math.max(0, plan.confidenceScore ?? 0.5)),
        risks: plan.risks ?? [],
    }
}
