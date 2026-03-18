// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

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
import { generateText } from 'ai'
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

// Lenient: accept either a full object, a bare string, or a number from the LLM.
// Smaller models (llama, groq) often return string[] or number[] instead of object[].
const OneWayDoorSchema = z.union([
    z.object({
        description: z.string(),
        type: z.enum(['data_write', 'external_call', 'destructive', 'state_change']),
        reversibility: z.string(),
        requiresApproval: z.boolean(),
    }),
    z.string().transform((s) => ({
        description: s,
        type: 'state_change' as const,
        reversibility: 'unknown',
        requiresApproval: true,
    })),
    z.number().transform((n) => ({
        description: String(n),
        type: 'state_change' as const,
        reversibility: 'unknown',
        requiresApproval: true,
    })),
])

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
- If the task strictly requires digital media capabilities NOT listed in the manifest above (e.g. video_generation, image_generation, audio_generation, voice_synthesis), you MUST return type: "clarification" — never attempt to deliver digital modalities you cannot produce.
- BROWSER AUTOMATION: You have full interactive browser capabilities (browser_navigate, browser_click, browser_type, browser_select, browser_extract, browser_screenshot, browser_eval, browser_wait). You CAN interact with external websites — fill forms, click buttons, navigate pages, create profiles, sign up for services, post content, and perform any multi-step web workflow. Tasks involving website interaction are ACHIEVABLE. Plan them using browser_* tools.
- Think outside the box: If a task seems unachievable directly (e.g. "plan a party", "run a marketing campaign", "buy plane tickets"), DO NOT return clarification immediately. Instead, map the real-world problem to achievable digital subtasks. You can always research, write schedules, draft emails, structure databases, write scripts, or automate web workflows.
- Be solution-oriented: When planning for abstract or physical tasks, clearly state any additional apps, APIs, or integrations the user might need to connect (or that you could build) to complete the final mile.
- IMPORTANT EXCEPTION: If the task requires connecting to a third-party service/API that has no existing connection, and "synthesize_kapsel_skill" is listed in the manifest tools, you MUST use synthesize_kapsel_skill to build that connection. This is the self-extension mechanism — it creates new skills and connections autonomously. Never return clarification for service integration tasks when synthesize_kapsel_skill is available.
- NEVER decline a task for a website or service simply because it is not listed in the "Active connections" section of the manifest. Most websites and services (social media, SaaS, forms, dashboards) can be interacted with via BROWSER AUTOMATION tools without needing a direct API connection. If a task requires interacting with a website, it is ACHIEVABLE.
- NEVER return clarification for a task that can be accomplished via a browser, even if the user didn't explicitly say "use the browser". If they ask to "create a profile" or "post a message", assume the browser is a valid fulfillment path.
- When returning clarification: provide 1–4 concrete alternatives you CAN deliver with the available tools. Always include a written/text alternative.
- When returning a plan: prefer reversible actions, flag irreversible ones as one-way doors. Website interactions (account creation, form submissions, public posts) are one-way doors — flag them.
- Break work into atomic steps that can be verified independently.
- Research: Use web_search and web_fetch to gather information, read documentation, or verify facts. These are your "eyes" on the live web. Use browser_* tools when you need to interact with web pages (click, fill, navigate).
- Be conservative with confidence scores — only give 0.9+ if the path is fully clear.
- Steps should reference only tools listed in the capability manifest.
- If you are unsure, default to returning a 'plan' with a research and browser-based discovery phase rather than declining.`
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
        tools: [
            'read_file', 'write_file', 'shell', 'task_complete', 'write_asset', 'synthesize_kapsel_skill',
            'web_search', 'web_fetch', 'web_screenshot', 'image_search',
            'browser_navigate', 'browser_click', 'browser_type', 'browser_select', 'browser_extract', 'browser_screenshot', 'browser_eval', 'browser_wait'
        ],
        connections: [],
        models: [{ provider: 'anthropic', model: 'claude', supports: ['text', 'code', 'vision'], missing: ['image_generation', 'video_generation'] }],
        skills: [],
        allCapabilities: new Set([
            'read_file', 'write_file', 'shell', 'text', 'code', 'vision', 'synthesize_kapsel_skill',
            'web_search', 'web_fetch', 'web_screenshot', 'image_search',
            'browser_navigate', 'browser_click', 'browser_type', 'browser_select', 'browser_extract', 'browser_screenshot', 'browser_eval', 'browser_wait'
        ]),
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

    const JSON_INSTRUCTIONS = `

Respond with ONLY valid JSON matching exactly one of these two shapes. No markdown fences, no commentary.

Shape 1 — plan (use when the task is achievable with available tools):
{"type":"plan","goal":"<overall goal>","steps":[{"stepNumber":1,"description":"<what to do>","toolsRequired":["<tool>"],"verificationMethod":"<how to verify>","isOneWayDoor":false}],"oneWayDoors":[],"estimatedDurationMs":30000,"confidenceScore":0.9,"risks":[]}

Shape 2 — clarification (use ONLY when a required capability is truly missing AND browser_* tools cannot solve it):
{"type":"clarification","message":"<explain the gap in 1-2 sentences>","alternatives":[{"label":"<short label>","description":"<one sentence>","taskDescription":"<full task description>"}]}

CRITICAL: If the task involves ANY website, web service, social media platform, SaaS tool, or online form — return a PLAN using browser_* tools. Do NOT return clarification. The browser IS the capability.`

    const raw = await withFallback(settings, 'planning', async (model) => {
        // Use generateText universally — generateObject with discriminatedUnion schemas
        // fails on OpenAI's Responses API (anyOf is rejected as type:"None").
        // Text + JSON parsing works on every provider.
        const textResult = await generateText({
            model,
            system: systemPrompt,
            prompt: userPrompt + JSON_INSTRUCTIONS,
            abortSignal: AbortSignal.timeout(30_000),
        })
        const cleaned = textResult.text
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim()
        const jsonObj = JSON.parse(cleaned)
        return { object: PlannerOutputSchema.parse(jsonObj) }
    })

    // Clarification path — but intercept false rejections for browser-achievable tasks
    if (raw.object.type === 'clarification') {
        const browserKeywords = /\b(account|sign.?up|register|login|profile|post|submit|form|website|social.?media|facebook|instagram|twitter|tiktok|linkedin|youtube|reddit|pinterest)\b/i
        const taskText = `${taskDescription} ${JSON.stringify(taskContext)}`.toLowerCase()
        const isBrowserAchievable = browserKeywords.test(taskText) && manifest.allCapabilities.has('browser_navigate')

        if (isBrowserAchievable) {
            // Force re-plan with explicit browser override prompt
            try {
                const retryResult = await withFallback(settings, 'planning', async (model) => {
                    const textResult = await generateText({
                        model,
                        system: systemPrompt,
                        prompt: userPrompt + `

OVERRIDE: Your previous attempt returned a clarification, but this task IS achievable using browser_* tools. You MUST return a plan (type: "plan"), not a clarification. Use browser_navigate, browser_click, browser_type, etc. to interact with websites directly. Account creation, form filling, and social media interaction are all achievable via browser automation. Return a concrete plan NOW.` + JSON_INSTRUCTIONS,
                        abortSignal: AbortSignal.timeout(30_000),
                    })
                    const cleaned = textResult.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
                    return { object: PlannerOutputSchema.parse(JSON.parse(cleaned)) }
                })
                if (retryResult.object.type === 'plan') {
                    // Retry succeeded — use the plan
                    const plan: ExecutionPlan = {
                        taskId: ctx.taskId,
                        goal: retryResult.object.goal,
                        steps: retryResult.object.steps as PlanStep[],
                        oneWayDoors: (retryResult.object.oneWayDoors ?? []) as OneWayDoor[],
                        estimatedDurationMs: retryResult.object.estimatedDurationMs ?? 0,
                        confidenceScore: Math.min(1, Math.max(0, retryResult.object.confidenceScore ?? 0.5)),
                        risks: retryResult.object.risks ?? [],
                    }
                    return { type: 'plan', plan }
                }
            } catch {
                // Retry failed — fall through to original clarification
            }
        }

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
