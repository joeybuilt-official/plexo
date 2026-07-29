// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Sprint planner — given a repo + request, produces a list of SprintTask
 * records that can be executed in parallel with dependency ordering.
 */
import { z } from 'zod'
import pino from 'pino'
import { eq } from 'drizzle-orm'
import { db } from '@plexo/db'
import { sprints, sprintTasks } from '@plexo/db'
import { AnyLanguageModel } from '../providers/registry.js'
import { routeAndCall } from '../providers/router-v2/index.js'
import { callModel } from '../providers/call-model.js'
import { categoryPlannerPrompt } from './categories.js'
import { buildCapabilityManifest, manifestToPromptBlock } from '../capabilities/manifest.js'
import { SprintIntelligence } from './sprint-intelligence.js'
import { buildExecutionWaves } from '../utils/topo-sort.js'

const logger = pino({ name: 'sprint-planner' })

// ── Types ────────────────────────────────────────────────────────────────────

export interface SprintTask {
    id: string        // local id within plan (e.g. "t1") — NOT db id
    description: string
    scope: string[]   // paths the task may touch
    acceptance: string
    branch: string
    priority: number
    depends_on: string[]
}

export interface SprintPlan {
    tasks: SprintTask[]
    parallelism_note?: string
}

export interface PlanResult {
    sprintId: string
    tasks: Array<SprintTask & { dbId: string }>
    executionOrder: string[][] // waves of parallel tasks (by local id)
}

// ── Schema ───────────────────────────────────────────────────────────────────

const SprintTaskSchema = z.object({
    id: z.string(),
    description: z.string(),
    scope: z.array(z.string()),
    acceptance: z.string(),
    branch: z.string(),
    priority: z.number(),
    depends_on: z.array(z.string()),
})

const SprintPlanSchema = z.object({
    tasks: z.array(SprintTaskSchema).max(8),
    parallelism_note: z.string(),   // required by OpenAI strict JSON schema mode (no optional fields)
})

// ── Planner ───────────────────────────────────────────────────────────────────

export async function planSprint(params: {
    sprintId: string
    workspaceId: string
    repo?: string          // undefined for non-code categories
    request: string
    contextFiles?: string[]
    category?: string      // defaults to 'code'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    aiSettings?: any       // workspace AI settings object for fallback routing
}): Promise<PlanResult> {
    const { sprintId, workspaceId, repo, request, contextFiles = [], category = 'code', aiSettings } = params

    logger.info({ sprintId, repo, category }, 'Sprint planning started')

    const systemPrompt = categoryPlannerPrompt(category, request)

    let agentsMdBlock = ''
    try {
        const { resolveBehavior } = await import('../behavior/resolver.js')
        const { compileBehavior } = await import('../behavior/compiler.js')
        const projectOrWorkspaceRules = await resolveBehavior(workspaceId)
        const compiled = compileBehavior(projectOrWorkspaceRules.rules)
        if (compiled) {
            agentsMdBlock = `\n\nWORKSPACE & PROJECT CONVENTIONS:\n${compiled}`
        }
    } catch {
        // Non-fatal — planner proceeds without it
    }

    let priorIntelligence = ''
    if (repo) {
        const intel = new SprintIntelligence(repo)
        priorIntelligence = await intel.getPriorIntelligence()
    }

    const userMessage = [
        repo ? `Repository: ${repo}` : null,
        `Request: ${request}`,
        contextFiles.length > 0 ? `\nKey files in repo:\n${contextFiles.slice(0, 50).join('\n')}` : null,
        priorIntelligence || null,
        agentsMdBlock || null,
    ].filter((s): s is string => s !== null).join('\n')

    // Phase D: inject capability manifest so the planner won't assign tasks
    // requiring capabilities that aren't installed (e.g. video_generation)
    let capabilityNote = ''
    try {
        const manifest = await buildCapabilityManifest(workspaceId)
        capabilityNote = '\n\n' + manifestToPromptBlock(manifest) + '\n\nIMPORTANT: Only plan tasks achievable with the above capabilities. If a requested task would require video_generation, image_generation, audio_generation, or voice_synthesis and no tool/connection supports it, substitute with a text/document deliverable instead (e.g. "video script" instead of "video"). Web access is READ-ONLY via web_search, web_read_page, and web_fetch — there is no interactive browser automation. For tasks that need to write to external services, prefer installed connections or synthesize_extension.'
    } catch { /* non-fatal */ }

    const PLANNER_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes — fail fast rather than hanging
    const doPlan = async (model: AnyLanguageModel) => {
        // Phase I Stage 2: route through the callModel wrapper so we get
        // C5 generateObject-with-repair behavior (native generateObject →
        // generateText+JSON-extract+zod-validate retry on schema-capability
        // errors) for free. Cross-provider fall-through stays at the
        // withFallback layer (one level up) — wrapper-level fallbackChain
        // is empty here.
        const result = await callModel({
            model,
            schema: SprintPlanSchema,
            system: systemPrompt,
            prompt: userMessage + capabilityNote,
            stepTimeoutMs: PLANNER_TIMEOUT_MS,
            taskType: 'planning',
        })
        return result.object as SprintPlan
    }

    let rawPlan: SprintPlan
    try {
        if (aiSettings) {
            // Pre-check: ensure at least one provider in the chain has a key.
            // If none are usable, fail fast with a clear error instead of hanging
            // on LLM auth failures deep in withFallback.
            const chain = [aiSettings.primaryProvider, ...(aiSettings.fallbackChain ?? [])]
            const hasUsableProvider = chain.some((key: string) => {
                const p = aiSettings.providers?.[key]
                if (!p || p.enabled === false) return false
                return !!(p.apiKey || p.baseUrl || p.status === 'configured')
            })
            if (!hasUsableProvider) {
                throw new Error(
                    'No AI provider is configured for this workspace. ' +
                    'Go to Settings → AI Providers and add at least one API key.'
                )
            }
            rawPlan = await routeAndCall({ workspaceId, taskType: 'planning', settings: aiSettings, doCall: doPlan })
        } else {
            // No workspace AI settings → router-v2 cannot select a provider.
            // Per the no-hardwired-provider policy, fail loud (the fix is to
            // configure the workspace) rather than silently falling back to a
            // pinned Anthropic model that bypasses routing + workspace config.
            throw new Error(
                'Sprint planning requires workspace AI settings to route a model. ' +
                'Go to Settings → AI Providers and configure at least one provider.'
            )
        }
    } catch (err) {
        logger.error({ err, sprintId }, 'Sprint planner LLM call failed')
        throw new Error(`Sprint planning failed: ${(err as Error).message}`)
    }

    if (!Array.isArray(rawPlan.tasks) || rawPlan.tasks.length === 0) {
        throw new Error('Sprint planner returned no tasks')
    }

    // Cap at 8 tasks and substitute {sprintId} placeholder
    const tasks = rawPlan.tasks.slice(0, 8).map((t, i) => ({
        ...t,
        branch: t.branch.replace('{sprintId}', sprintId),
        priority: t.priority ?? (i + 1),
        depends_on: t.depends_on ?? [],
    }))

    // Persist sprint_tasks rows. Postgres is the authoritative store.
    const insertedRows = await persistSprintTasks(sprintId, tasks)

    await db.update(sprints).set({ totalTasks: insertedRows.length }).where(eq(sprints.id, sprintId))

    const executionOrder = await computeExecutionOrder({ workspaceId, sprintId, tasks })

    logger.info({ sprintId, taskCount: insertedRows.length, waves: executionOrder.length }, 'Sprint plan complete')

    return { sprintId, tasks: insertedRows, executionOrder }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function persistSprintTasks(
    sprintId: string,
    tasks: SprintTask[],
): Promise<Array<SprintTask & { dbId: string }>> {
    const results: Array<SprintTask & { dbId: string }> = []

    for (const task of tasks) {
        const dbId = crypto.randomUUID()
        await db.insert(sprintTasks).values({
            id: dbId,
            sprintId,
            description: task.description,
            scope: task.scope,
            acceptance: task.acceptance,
            branch: task.branch,
            priority: task.priority,
            status: 'queued',
        })
        results.push({ ...task, dbId })
    }

    return results
}

/**
 * Compute execution order — layered BFS from the postgres task DAG.
 */
async function computeExecutionOrder(params: {
    workspaceId: string
    sprintId: string
    tasks: SprintTask[]
}): Promise<string[][]> {
    return buildExecutionWaves(params.tasks)
}

