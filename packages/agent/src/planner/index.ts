/**
 * Task planner — Phase D: Capability-aware with ClarificationRequest output.
 *
 * Returns either:
 *   { type: 'plan', plan: ExecutionPlan }        — task is achievable, proceed
 *   { type: 'clarification', message, alternatives } — gap detected, ask user
 *
 * The planner receives the workspace capability manifest so it can self-limit
 * to what is actually achievable. If a required capability is missing, it
 * returns a ClarificationRequest instead of a plan — the queue treats this as
 * status: 'blocked' and surfaces the alternatives to the user via their channel.
 */
import { generateObject, generateText } from 'ai'
import { z } from 'zod'
import { withFallback } from '../providers/registry.js'
import { SAFETY_LIMITS } from '../constants.js'
import { PlexoError } from '../errors.js'
import { buildCapabilityManifest, manifestToPromptBlock } from '../capabilities/manifest.js'
import type { ExecutionPlan, ExecutionContext, PlanStep, OneWayDoor, PlannerResult } from '../types.js'
import type { WorkspaceAISettings } from '../providers/registry.js'

// ── Schemas ────────────────────────────────────────────────────────────────────

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

const ExecutionPlanShape = z.object({
    type: z.literal('plan'),
    goal: z.string(),
    steps: z.array(PlanStepSchema).min(1),
    oneWayDoors: z.array(OneWayDoorSchema),
    estimatedDurationMs: z.number().nonnegative(),
    confidenceScore: z.number().min(0).max(1),
    risks: z.array(z.string()),
})

const ClarificationShape = z.object({
    type: z.literal('clarification'),
    message: z.string().describe('Explain what you cannot do and why, in one or two sentences.'),
    alternatives: z.array(z.object({
        label: z.string().describe('Short button label, e.g. "Write a video script"'),
        description: z.string().describe('One sentence: what will be delivered'),
        taskDescription: z.string().describe('Full task description to queue if user picks this'),
    })).min(1).max(4),
})

const PlannerOutputSchema = z.discriminatedUnion('type', [ExecutionPlanShape, ClarificationShape])

// ── System prompt builder ──────────────────────────────────────────────────────

function buildPlannerSystem(
    capabilityBlock: string,
    workspaceName?: string,
    sprintGoal?: string,
): string {
    const contextBlock = [
        workspaceName ? `Workspace: ${workspaceName}` : null,
        sprintGoal ? `Active project goal: ${sprintGoal}` : null,
    ].filter(Boolean).join('\n')

    return `You are Plexo's execution planner. Analyze a task and produce either a safe execution plan or a clarification request.

${capabilityBlock}

${contextBlock ? `CONTEXT:\n${contextBlock}\n` : ''}
RULES:
- If the task requires capabilities NOT listed in the manifest above (e.g. video_generation, image_generation, audio_generation, voice_synthesis, or any service not in Active connections), you MUST return type: "clarification" — never attempt a plan for work you cannot deliver.
- When returning clarification: provide 1–4 concrete alternatives you CAN deliver with the available tools. Always include a written/text alternative.
- When returning a plan: prefer reversible actions, flag irreversible ones as one-way doors.
- Break work into atomic steps that can be verified independently.
- Be conservative with confidence scores — only give 0.9+ if the path is fully clear.
- Steps should reference only tools listed in the capability manifest.`
}

// ── Default workspace AI settings ─────────────────────────────────────────────

function defaultSettings(): WorkspaceAISettings {
    return {
        primaryProvider: 'anthropic',
        fallbackChain: [],
        providers: {
            anthropic: { provider: 'anthropic' },
        },
    }
}

// ── Planner ────────────────────────────────────────────────────────────────────

export async function planTask(
    ctx: ExecutionContext,
    taskDescription: string,
    taskContext: Record<string, unknown>,
    aiSettings?: WorkspaceAISettings,
): Promise<PlannerResult> {
    const settings = aiSettings ?? defaultSettings()

    // Build capability manifest (Phase D)
    const manifest = await buildCapabilityManifest(ctx.workspaceId).catch(() => ({
        tools: ['read_file', 'write_file', 'shell', 'task_complete', 'write_asset'],
        connections: [],
        models: [{ provider: 'anthropic', model: 'claude', supports: ['text', 'code'], missing: ['image_generation', 'video_generation'] }],
        skills: [],
        allCapabilities: new Set(['read_file', 'write_file', 'shell', 'text', 'code']),
    }))

    const capabilityBlock = manifestToPromptBlock(manifest)
    const systemPrompt = buildPlannerSystem(capabilityBlock, ctx.workspaceName, ctx.sprintGoal)

    const userPrompt = JSON.stringify({
        task: taskDescription,
        context: taskContext,
        constraints: {
            maxSteps: SAFETY_LIMITS.MAX_PLAN_STEPS,
            tokenBudget: ctx.tokenBudget,
        },
    })

    const raw = await withFallback(settings, 'planning', async (model) => {
        try {
            return await generateObject({
                model,
                system: systemPrompt,
                prompt: userPrompt,
                schema: PlannerOutputSchema,
            })
        } catch (structuredErr) {
            const errMsg = (structuredErr as Error).message ?? ''
            if (errMsg.includes('json_schema') || errMsg.includes('response format') || errMsg.includes('structured output')) {
                const jsonInstruction = `\n\nRespond with ONLY valid JSON — no markdown, no commentary. Use exactly one of these shapes:\n{"type":"plan","goal":string,"steps":[{"stepNumber":number,"description":string,"toolsRequired":string[],"verificationMethod":string,"isOneWayDoor":boolean}],"oneWayDoors":[],"estimatedDurationMs":number,"confidenceScore":number,"risks":string[]}\nor\n{"type":"clarification","message":string,"alternatives":[{"label":string,"description":string,"taskDescription":string}]}`
                const textResult = await generateText({
                    model,
                    system: systemPrompt,
                    prompt: userPrompt + jsonInstruction,
                })
                const raw = textResult.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
                const jsonObj = JSON.parse(raw)
                return { object: PlannerOutputSchema.parse(jsonObj) }
            }
            throw structuredErr
        }
    })

    // Clarification path — return as-is for the queue to handle
    if (raw.object.type === 'clarification') {
        return {
            type: 'clarification',
            message: raw.object.message,
            alternatives: raw.object.alternatives,
        }
    }

    // Plan path
    if (raw.object.steps.length > SAFETY_LIMITS.MAX_PLAN_STEPS) {
        throw new PlexoError(
            `Plan has ${raw.object.steps.length} steps — exceeds safety limit of ${SAFETY_LIMITS.MAX_PLAN_STEPS}`,
            'PLAN_TOO_LARGE',
            'user',
            400,
        )
    }

    const plan: ExecutionPlan = {
        taskId: ctx.taskId,
        goal: raw.object.goal,
        steps: raw.object.steps as PlanStep[],
        oneWayDoors: (raw.object.oneWayDoors ?? []) as OneWayDoor[],
        estimatedDurationMs: raw.object.estimatedDurationMs ?? 0,
        confidenceScore: Math.min(1, Math.max(0, raw.object.confidenceScore ?? 0.5)),
        risks: raw.object.risks ?? [],
    }

    return { type: 'plan', plan }
}
