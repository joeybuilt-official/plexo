// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Sprint planner — given a repo + request, produces a list of SprintTask
 * records that can be executed in parallel with dependency ordering.
 */
import { generateObject, generateText } from 'ai'
import { z } from 'zod'
import pino from 'pino'
import { db, eq } from '@plexo/db'
import { sprints, sprintTasks } from '@plexo/db'
import { resolveModelFromEnv, withFallback, AnyLanguageModel } from '../providers/registry.js'
import { MODEL_ROUTING } from '../constants.js'
import { categoryPlannerPrompt } from './categories.js'
import { buildCapabilityManifest, manifestToPromptBlock } from '../capabilities/manifest.js'
import { SprintIntelligence } from './sprint-intelligence.js'

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

    const systemPrompt = categoryPlannerPrompt(category)

    // Fetch unified behavior rules instead of raw AGENTS.md text
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
        capabilityNote = '\n\n' + manifestToPromptBlock(manifest) + '\n\nIMPORTANT: Only plan tasks achievable with the above capabilities. If a requested task would require video_generation, image_generation, audio_generation, or any connection not listed, substitute it with a text/document deliverable instead (e.g. "video script" instead of "video").'
    } catch { /* non-fatal */ }

    const PLANNER_TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes — fail fast rather than hanging
    const doPlan = async (model: AnyLanguageModel) => {
        let parsed: SprintPlan | null = null
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(new Error('Sprint planner timed out after 3 minutes')), PLANNER_TIMEOUT_MS)
        try {
            const result = await generateObject({
                model,
                schema: SprintPlanSchema,
                system: systemPrompt,
                prompt: userMessage + capabilityNote,
                abortSignal: ac.signal,
            })
            parsed = result.object
        } catch (structuredErr) {
            // Some providers (e.g. most Groq models) don't support json_schema
            // structured output. Fall back to generateText with an explicit JSON
            // instruction and manual parse.
            const errMsg = (structuredErr as Error).message ?? ''
            if (errMsg.includes('json_schema') || errMsg.includes('response format') || errMsg.includes('structured output')) {
                logger.warn({ sprintId, errMsg }, 'Model does not support json_schema — retrying with generateText + manual JSON parse')
                const jsonInstruction = `\n\nRespond with ONLY a JSON object matching this exact schema — no markdown, no commentary:\n{"tasks": [{"id": string, "description": string, "scope": string[], "acceptance": string, "branch": string, "priority": number, "depends_on": string[]}], "parallelism_note": string}`
                const textResult = await generateText({
                    model,
                    system: systemPrompt,
                    prompt: userMessage + capabilityNote + jsonInstruction,
                    abortSignal: ac.signal,
                })
                // Strip markdown fences if present
                const raw = textResult.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
                const jsonObj = JSON.parse(raw)
                parsed = SprintPlanSchema.parse(jsonObj)
            } else {
                throw structuredErr
            }
        } finally {
            clearTimeout(timer)
        }
        return parsed!
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
            rawPlan = await withFallback(aiSettings, 'planning', doPlan)
        } else {
            rawPlan = await doPlan(resolveModelFromEnv(MODEL_ROUTING.planning))
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

    // Persist sprint_tasks rows
    const insertedRows = await persistSprintTasks(sprintId, tasks)

    // Update sprint total_tasks count
    await db.update(sprints).set({ totalTasks: insertedRows.length }).where(eq(sprints.id, sprintId))

    // Build execution order (topological sort into parallel waves)
    const executionOrder = buildExecutionOrder(tasks)

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
 * Topological sort → execution waves.
 * Tasks in the same wave are independent and can run in parallel.
 */
function buildExecutionOrder(tasks: SprintTask[]): string[][] {
    const idSet = new Set(tasks.map((t) => t.id))
    const resolved = new Set<string>()
    const waves: string[][] = []
    let remaining = [...tasks]

    while (remaining.length > 0) {
        const wave = remaining.filter((t) =>
            t.depends_on.every((dep) => !idSet.has(dep) || resolved.has(dep)),
        )

        if (wave.length === 0) {
            // Cycle — dump the rest as one wave
            waves.push(remaining.map((t) => t.id))
            break
        }

        waves.push(wave.map((t) => t.id))
        for (const t of wave) resolved.add(t.id)
        remaining = remaining.filter((t) => !resolved.has(t.id))
    }

    return waves
}
