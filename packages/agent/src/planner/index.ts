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
import pino from 'pino'
import { z } from 'zod'
import { withFallback } from '../providers/registry.js'
import { SAFETY_LIMITS } from '../constants.js'
import { PlexoError } from '../errors.js'
import { buildCapabilityManifest, manifestToPromptBlock } from '../capabilities/manifest.js'
import { readFromGraphiti } from '../memory/read-backend.js'
import { emitMemoryInjection } from '../analytics/memory-events.js'
import type { ExecutionPlan, ExecutionContext, PlanStep, OneWayDoor, PlannerResult } from '../types.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { buildExecutionWaves } from '../utils/topo-sort.js'
import { OUTBOUND_VERB_EXAMPLES } from '../one-way-door.js'

const logger = pino({ name: 'planner' })

// ── Schemas ────────────────────────────────────────────────────────────────────

const PlanStepSchema = z.object({
    stepNumber: z.number().int().positive(),
    description: z.string(),
    toolsRequired: z.array(z.string()).default([]),
    verificationMethod: z.string().default('Manual review'),
    isOneWayDoor: z.boolean().default(false),
    depends_on: z.array(z.number().int().positive()).default([]),
})

// Lenient: accept either a full object or a bare string from the LLM.
// Smaller models (llama, groq) often return string[] instead of object[].
//
// We DELIBERATELY removed the previous z.number() branch — when the LLM
// returned a bare numeric like `4` (often "4 irreversible operations"
// summarized to a count), the lenient transform turned it into
// `{ description: "4", type: "state_change" }` and the user saw an
// approval card titled "[state_change] 4" with no information about what
// was actually being changed. Better to drop the entry and let the
// planner retry than to surface garbage approvals.
//
// String entries are also tightened to min(5) so things like " " or
// "1" don't slip through the same way.
const OneWayDoorSchema = z.union([
    z.object({
        description: z.string().min(5),
        type: z.enum(['data_write', 'external_call', 'destructive', 'state_change']),
        reversibility: z.string(),
        requiresApproval: z.boolean(),
    }),
    // Tolerate numbers: LLMs sometimes return oneWayDoors:[4] meaning
    // "4 irreversible operations". Drop these silently instead of
    // throwing a ZodError that blocks the entire task.
    z.number().transform(() => null),
    z.string().min(5).transform((s) => ({
        description: s,
        type: 'state_change' as const,
        reversibility: 'unknown',
        requiresApproval: true,
    })),
])

const PhaseSchema = z.object({
    label: z.string().describe('Present-tense action label: "Scanning repo", "Writing migration"'),
    description: z.string().optional(),
})

const ExecutionPlanShape = z.object({
    type: z.literal('plan'),
    goal: z.string(),
    steps: z.array(PlanStepSchema).min(1),
    oneWayDoors: z.array(OneWayDoorSchema).default([]).transform(arr => arr.filter(Boolean)),
    estimatedDurationMs: z.number().nonnegative().default(30000),
    // .refine instead of .min().max() — Anthropic structured-output rejects
    // {minimum, maximum} on number-typed JSON Schema fields. See quality-judge.ts.
    confidenceScore: z.number().refine((n) => n >= 0 && n <= 1, { message: 'confidenceScore must be 0..1' }).default(0.8),
    // Accept either string[] (preferred) or object[] (LLM occasionally emits
    // `[{description: "...", mitigation: "..."}]`). Coerce objects → "description"
    // string so downstream callers see a uniform string[] regardless of LLM shape.
    risks: z.preprocess(
        (val) => {
            if (!Array.isArray(val)) return val
            return val.map((r) => {
                if (typeof r === 'string') return r
                if (r && typeof r === 'object') {
                    const obj = r as Record<string, unknown>
                    const desc = obj.description ?? obj.risk ?? obj.text ?? obj.summary
                    if (typeof desc === 'string') return desc
                    try { return JSON.stringify(r) } catch { return String(r) }
                }
                return String(r)
            })
        },
        z.array(z.string()).default([]),
    ),
    phases: z.array(PhaseSchema).optional().default([]),
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
    memoryBlock?: string,
): string {
    const contextBlock = [
        workspaceName ? `Workspace: ${workspaceName}` : null,
        sprintGoal ? `Active project goal: ${sprintGoal}` : null,
    ].filter(Boolean).join('\n')

    return `You are Plexo's execution planner. Analyze a task and produce either a safe execution plan or a clarification request.

${capabilityBlock}

${contextBlock ? `CONTEXT:\n${contextBlock}\n` : ''}${memoryBlock ? `${memoryBlock}\n` : ''}
RULES:
- FIRST QUESTION — "Can the model do this in one step from its own knowledge?" If the task is a well-known coding pattern the executor model trivially knows (snake game, todo list, tic-tac-toe, calculator, static landing page, a standard algorithm, a simple script, an email draft, a short copy piece), the correct plan is ONE step: call write_asset with the finished output. DO NOT insert a research phase, a web_search step, a verification step, or a "refine" step for tasks the model can produce from memory. Extra steps on self-contained tasks waste 30+ seconds and cause context bloat. Use research phases ONLY when the task references a specific real-world entity, current event, proprietary API, or live data the model does not have in its training. A plan with more steps is NOT a better plan — match step count to actual complexity.
- If the task strictly requires digital media capabilities NOT listed in the manifest above (e.g. video_generation, image_generation, audio_generation, voice_synthesis), you MUST return type: "clarification" — never attempt to deliver digital modalities you cannot produce.
- WEB ACCESS: You have three web tools — web_search (titles/URLs/snippets from Tavily|Brave|DuckDuckGo), web_read_page (fetches a URL and returns its main readable text with HTML stripped), and web_fetch (raw HTTP GET/POST for JSON APIs). These are READ-ONLY — no JavaScript execution, no form filling, no clicking. If a task genuinely requires interactive browser automation (filling forms, clicking buttons, multi-step JS-driven flows), return a clarification explaining which part needs interaction and suggest installing a browser-automation tool from the Hub.
- Think outside the box: If a task seems unachievable directly (e.g. "plan a party", "run a marketing campaign", "buy plane tickets"), DO NOT return clarification immediately. Instead, map the real-world problem to achievable digital subtasks. You can always research, write schedules, draft emails, structure databases, write scripts, or automate web workflows.
- Be solution-oriented: When planning for abstract or physical tasks, clearly state any additional apps, APIs, or integrations the user might need to connect (or that you could build) to complete the final mile.
- IMPORTANT EXCEPTION: If the task requires connecting to a third-party service/API that has no existing connection, and "synthesize_extension" is listed in the manifest tools, you MUST use synthesize_extension to build that connection. This is the self-extension mechanism — it creates new skills and connections autonomously. Never return clarification for service integration tasks when synthesize_extension is available.
- NEVER decline a task for a website or service simply because it is not listed in the "Active connections" section of the manifest. Many read-only tasks (research, summaries, scraping static content) work fine with web_search + web_read_page.
- For tasks that need WRITING to an external service (posting content, filling forms, creating accounts), prefer synthesize_extension to build a real API integration rather than attempting to do it via raw HTTP. Return clarification only if neither read-only web tools nor synthesize_extension fits.
- When returning clarification: provide 1–4 concrete alternatives you CAN deliver with the available tools. Always include a written/text alternative.
- When returning a plan: prefer reversible actions, flag irreversible ones as one-way doors. Website interactions (account creation, form submissions, public posts) are one-way doors — flag them. Outbound communication (sending email, SMS, chat messages, public posts) is also a one-way door — flag it.
- STEP TOOLSREQUIRED ACCURACY (SAFETY-CRITICAL): every step's toolsRequired array MUST list every tool the executor will call to satisfy that step. Never emit toolsRequired: [] for steps that invoke tools. Never omit tools you intend the executor to call. The post-planner safety pipeline relies on accurate tool declarations to elevate outbound-channel calls (${OUTBOUND_VERB_EXAMPLES.slice(0, 6).join(', ')}, etc.) to one-way-door status. Inaccurate toolsRequired is treated as a planning defect.
- EMAIL ATTACHMENTS: When an email tool's input schema includes an \`attachments\` array, populate it ONLY when the operator has asked for files to be attached. Forward-mode (referencing existing inbound contentHash) is preferred over upload-mode. Do not invent file content.
- Break work into atomic steps that can be verified independently.
- Research: Use web_search to find sources, then web_read_page to read them (clean text), or web_fetch for raw JSON APIs. These three are your only web access — no browser automation.
- Be conservative with confidence scores — only give 0.9+ if the path is fully clear.
- Steps should reference only tools listed in the capability manifest.
- If you are unsure, default to returning a 'plan' with a research and browser-based discovery phase rather than declining.

PHASES (optional but preferred):
- Include a "phases" array in your plan output with 2-6 high-level phases of the work.
- Each phase has a "label" (present tense, action-oriented: "Scanning repository", "Writing migration", "Running tests") and optional "description".
- Phases group steps into user-visible progress milestones. They are NOT steps — they are higher-level than steps.
- If the task is simple (1-2 steps), omit phases entirely. Do not create fake phases for simple tasks.`
}

// ── Default workspace AI settings ─────────────────────────────────────────────

/** Compute execution waves from plan steps using their depends_on edges.
 *
 * Phase B1 (ADR 0020): wired through `FALKORDB_PLANNER_WAVES` for
 * parity w/ `sprint/planner.ts`, but PlanStep records are ephemeral
 * (in-memory only — never persisted to FalkorDB) so the cypher path
 * has no data to read. The flag exists here as scaffolding for the
 * follow-up that persists plan steps as Task nodes; until then this
 * always falls through to JS. We accept a `sprintId` arg threaded from
 * `planTask` (taskId is the closest analog) for future use.
 */
function computeWaves(steps: PlanStep[], _sprintIdForCypher?: string, _workspaceIdForCypher?: string): number[][] {
    // Future: when plan steps are persisted as Task nodes, gate cypher
    // path here on FALKORDB_PLANNER_WAVES + workspaceId + sprintId.
    const nodes = steps.map((s) => ({
        id: String(s.stepNumber),
        depends_on: (s.depends_on ?? []).map(String),
    }))
    return buildExecutionWaves(nodes).map((wave) => wave.map(Number))
}

function defaultSettings(): WorkspaceAISettings {
    return {
        primaryProvider: 'anthropic',
        fallbackChain: [],
        providers: {
            anthropic: { provider: 'anthropic' },
        },
    }
}

const MEMORY_FACT_LIMIT = 5
const MEMORY_FACT_CHAR_CAP = 240

/**
 * Phase 6 — memory-informed planning. Pull up to 5 high-confidence memory
 * entries (vector similarity against the task description) and render them
 * as a "RELEVANT PAST CONTEXT" block. Returns undefined on empty results
 * or any retrieval failure so planning never blocks on memory.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function buildMemoryBlock(
    workspaceId: string,
    userId: string,
    queryText: string,
    aiSettings: WorkspaceAISettings,
): Promise<string | undefined> {
    try {
        void userId
        void aiSettings
        const hits = await readFromGraphiti({
            workspaceId,
            queryText,
            limit: MEMORY_FACT_LIMIT,
        })
        const hitCount = hits?.length ?? 0
        emitMemoryInjection({ workspaceId, userId, factsInjected: hitCount, retrievalFailed: false })
        if (!hits || hits.length === 0) return undefined
        const lines = hits.map((h) => {
            const text = (h.shorthand?.trim() || h.content.trim()).replace(/\s+/g, ' ')
            return `- ${text.length > MEMORY_FACT_CHAR_CAP ? text.slice(0, MEMORY_FACT_CHAR_CAP - 1) + '…' : text}`
        })
        return `RELEVANT PAST CONTEXT (from prior tasks and learned facts — use to avoid known failures and reuse established patterns; ignore if not applicable):\n${lines.join('\n')}`
    } catch (err) {
        logger.warn({ err, workspaceId }, 'planner: graphiti memory read failed — proceeding without memory context')
        emitMemoryInjection({ workspaceId, userId, factsInjected: 0, retrievalFailed: true })
        return undefined
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

    const manifest = await buildCapabilityManifest(ctx.workspaceId).catch(() => ({
        tools: [
            'read_file', 'write_file', 'shell', 'task_complete', 'write_asset', 'self_reflect', 'synthesize_extension',
            'web_search', 'web_fetch', 'web_read_page',
        ],
        connections: [],
        models: [{ provider: 'anthropic', model: 'claude', supports: ['text', 'code', 'vision'], missing: ['image_generation', 'video_generation'] }],
        skills: [],
        sshHosts: [],
        allCapabilities: new Set([
            'read_file', 'write_file', 'shell', 'text', 'code', 'vision', 'synthesize_extension',
            'web_search', 'web_fetch', 'web_read_page',
        ]),
    }))

    const capabilityBlock = manifestToPromptBlock(manifest)
    const memoryBlock = await buildMemoryBlock(ctx.workspaceId, ctx.userId, taskDescription, settings)
    const systemPrompt = buildPlannerSystem(capabilityBlock, ctx.workspaceName, ctx.sprintGoal, memoryBlock)

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
{"type":"plan","goal":"<overall goal>","steps":[{"stepNumber":1,"description":"<what to do>","toolsRequired":["<tool>"],"verificationMethod":"<how to verify>","isOneWayDoor":false,"depends_on":[]},{"stepNumber":2,"description":"<next step>","toolsRequired":["<tool>"],"verificationMethod":"<how to verify>","isOneWayDoor":false,"depends_on":[1]}],"oneWayDoors":[],"estimatedDurationMs":30000,"confidenceScore":0.9,"risks":[],"phases":[{"label":"Scanning codebase"},{"label":"Implementing changes"},{"label":"Verifying results"}]}

depends_on: list the stepNumbers this step must wait for. Steps with no dependencies get depends_on:[]. Use this to express the actual dependency structure — independent steps can have empty depends_on and will be identified as parallelizable.

Shape 2 — clarification (use ONLY when a required capability is truly missing AND browser_* tools cannot solve it):
{"type":"clarification","message":"<explain the gap in 1-2 sentences>","alternatives":[{"label":"<short label>","description":"<one sentence>","taskDescription":"<full task description>"}]}

CRITICAL: If the task involves ANY website, web service, social media platform, SaaS tool, or online form — return a PLAN using browser_* tools. Do NOT return clarification. The browser IS the capability.`

    const raw = await withFallback(settings, 'planning', async (model) => {
        // Phase 4 NOTE: This site is intentionally NOT migrated to
        // callModel({ schema: PlannerOutputSchema }). The planner's
        // output is a z.discriminatedUnion(['plan','clarification'], ...)
        // and `generateObject` emits JSON-Schema `anyOf` for discriminated
        // unions, which OpenAI's Responses API rejects as `type:"None"`.
        // Falling back to text + post-hoc Zod parse (what this code
        // already does) is the only portable option until either (a) the
        // SDK learns to emit a single-schema projection for discriminated
        // unions, or (b) we split the planner into two calls (plan OR
        // clarify) with separate object schemas.
        //
        // Phase 3 wrapper (callModel retry + abort + CALL_MODEL_* codes)
        // is still in force — this site only skips the Phase 4 schema
        // option. The hand-rolled parse here is already Zod-validated via
        // `PlannerOutputSchema.parse(jsonObj)` below, so the safety gate
        // is equivalent to the schema path.
        const { callModel } = await import('../providers/call-model.js')
        const textResult = await callModel({
            model,
            system: systemPrompt,
            prompt: userPrompt + JSON_INSTRUCTIONS,
            stepTimeoutMs: 120_000,
            taskType: 'planning',
        })
        // Extract JSON from response — models sometimes prefix with prose or reasoning
        let cleaned = textResult.text
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim()
        // If the response doesn't start with { or [, find the first JSON object
        if (!cleaned.startsWith('{') && !cleaned.startsWith('[')) {
            const jsonStart = cleaned.indexOf('{')
            if (jsonStart >= 0) {
                cleaned = cleaned.slice(jsonStart)
            }
        }
        // If there's trailing text after the JSON, find the matching closing brace
        if (cleaned.startsWith('{')) {
            let depth = 0
            let end = 0
            for (let i = 0; i < cleaned.length; i++) {
                if (cleaned[i] === '{') depth++
                else if (cleaned[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
            }
            if (end > 0) cleaned = cleaned.slice(0, end)
        }
        const jsonObj = JSON.parse(cleaned)
        return { object: PlannerOutputSchema.parse(jsonObj) }
    })

    // Clarification path — browser automation has been removed (dead Playwright code);
    // if the planner asks for clarification, surface it as-is.
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

    const planSteps = raw.object.steps as PlanStep[]
    const planPhases = (raw.object.phases ?? []).map((p, i) => ({ index: i, label: p.label, description: p.description }))
    const plan: ExecutionPlan = {
        taskId: ctx.taskId,
        goal: raw.object.goal,
        steps: planSteps,
        oneWayDoors: (raw.object.oneWayDoors ?? []) as OneWayDoor[],
        estimatedDurationMs: raw.object.estimatedDurationMs ?? 0,
        confidenceScore: Math.min(1, Math.max(0, raw.object.confidenceScore ?? 0.5)),
        risks: raw.object.risks ?? [],
        waves: computeWaves(planSteps, ctx.taskId, ctx.workspaceId),
        phases: planPhases.length > 0 ? planPhases : undefined,
    }

    return { type: 'plan', plan }
}
