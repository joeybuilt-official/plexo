// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Sprint planner — given a repo + request, produces a list of SprintTask
 * records that can be executed in parallel with dependency ordering.
 */
import { z } from 'zod'
import pino from 'pino'
import { db, eq } from '@plexo/db'
import { sprints, sprintTasks } from '@plexo/db'
import { resolveModelFromEnv, AnyLanguageModel } from '../providers/registry.js'
import { routeAndCall } from '../providers/router-v2/index.js'
import { callModel } from '../providers/call-model.js'
import { MODEL_ROUTING } from '../constants.js'
import { categoryPlannerPrompt } from './categories.js'
import { buildCapabilityManifest, manifestToPromptBlock } from '../capabilities/manifest.js'
import { SprintIntelligence } from './sprint-intelligence.js'
import { buildExecutionWaves } from '../utils/topo-sort.js'
import { buildCypherExecutionWavesById } from '../planner/cypher-waves.js'
import { createHmac } from 'node:crypto'

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

    // Persist sprint_tasks rows. Postgres is the authoritative store
    // until the B1 cutover ADR (0020) flips. Falkor dual-write fires
    // after the postgres insert and is awaited-with-catch — never
    // fails the sprint creation, but we want to know synchronously
    // when graph falls behind so the FALKORDB_PLANNER_WAVES read path
    // can be trusted.
    const insertedRows = await persistSprintTasks(sprintId, tasks)
    await dualWriteTaskDagToFalkor({ sprintId, workspaceId, tasks })

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

// ── Phase B1 (ADR 0020): task DAG dual-write + cypher waves ───────────────────

/**
 * Dual-write Task + DEPENDS_ON to FalkorDB via /v1/graph/write.
 * Awaited-with-catch — postgres remains authoritative, but we log +
 * emit telemetry so graph drift is visible before B1 cutover.
 */
async function dualWriteTaskDagToFalkor(params: {
    sprintId: string
    workspaceId: string
    tasks: SprintTask[]
}): Promise<void> {
    const { sprintId, workspaceId, tasks } = params
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) {
        logger.debug({ sprintId, workspaceId }, 'sprint-planner: falkor dual-write skipped — sidecar URL or key absent')
        return
    }

    const nodes = tasks.map((t) => ({
        label: 'Task',
        id: t.id,
        properties: {
            description: t.description,
            status: 'queued',
            priority: t.priority,
            scope: t.scope,
            acceptance: t.acceptance,
            branch: t.branch,
            sprint_id: sprintId,
        },
    }))
    const edges: Array<{
        type: 'DEPENDS_ON'
        from_label: 'Task'
        from_id: string
        to_label: 'Task'
        to_id: string
        properties: Record<string, never>
    }> = []
    for (const t of tasks) {
        for (const dep of t.depends_on ?? []) {
            edges.push({
                type: 'DEPENDS_ON',
                from_label: 'Task',
                from_id: t.id,
                to_label: 'Task',
                to_id: dep,
                properties: {},
            })
        }
    }

    const body = JSON.stringify({ workspace_id: workspaceId, app: 'plexo', nodes, edges })
    const sig = 'sha256=' + createHmac('sha256', serviceKey).update(body).digest('hex')
    const ts = new Date().toISOString()

    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/graph/write`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-App-Id': 'plexo-agent',
                'X-Plexo-Timestamp': ts,
                'X-Plexo-Signature': sig,
            },
            body,
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            logger.warn({ sprintId, workspaceId, status: res.status, body: text.slice(0, 200) }, 'sprint-planner: falkor dual-write returned non-OK — postgres is authoritative')
        } else {
            logger.info({ sprintId, workspaceId, nodes: nodes.length, edges: edges.length }, 'sprint-planner: falkor dual-write ok')
        }
    } catch (err) {
        logger.warn({ err, sprintId, workspaceId }, 'sprint-planner: falkor dual-write failed — postgres is authoritative')
    }
}

/**
 * Compute execution order — gated on `FALKORDB_PLANNER_WAVES=true`.
 * The JS path is always the fallback on env-off, cypher-error, or any
 * shape mismatch. Critical path: agent loop drives off these waves, so
 * we MUST surface a non-null answer.
 */
async function computeExecutionOrder(params: {
    workspaceId: string
    sprintId: string
    tasks: SprintTask[]
}): Promise<string[][]> {
    const { workspaceId, sprintId, tasks } = params
    const flag = (process.env.FALKORDB_PLANNER_WAVES ?? '').toLowerCase()
    if (flag === 'true' || flag === '1') {
        try {
            const cypherWaves = await buildCypherExecutionWavesById(workspaceId, sprintId)
            if (cypherWaves && cypherWaves.length > 0) {
                // Sanity: cypher must cover every task — if it doesn't,
                // graph is behind on the dual-write. Fall back to JS.
                const cypherCount = cypherWaves.reduce((n, w) => n + w.length, 0)
                if (cypherCount === tasks.length) {
                    logger.info({ sprintId, waves: cypherWaves.length }, 'sprint-planner: using cypher execution waves')
                    return cypherWaves
                }
                logger.warn({ sprintId, cypherCount, taskCount: tasks.length }, 'sprint-planner: cypher waves missing tasks — falling back to JS')
            }
        } catch (err) {
            logger.warn({ err, sprintId }, 'sprint-planner: cypher waves threw — falling back to JS')
        }
    }
    return buildExecutionWaves(tasks)
}

