// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { claimTask, completeTask, blockTask } from '@plexo/queue'
import { db, eq, sql } from '@plexo/db'
import { tasks, apiCostTracking, workspaces, sprints, sprintTasks } from '@plexo/db'
import { planTask } from '@plexo/agent/planner'
import { executeTask } from '@plexo/agent/executor'
import { recordTaskMemory } from '@plexo/agent/memory/store'
import type { AnthropicCredential, ExecutionContext } from '@plexo/agent/types'
import { emitToWorkspace } from './sse-emitter.js'
import { registerCodeContext, unregisterCodeContext } from './routes/code.js'
import { emitTaskOutcome } from './telemetry/events.js'
import { captureLifecycleEvent } from './sentry.js'
import type { WorkspaceAISettings, ProviderKey } from '@plexo/agent/providers/registry'
import { logger } from './logger.js'

import { loadDecryptedAIProviders } from './routes/ai-provider-creds.js'
import { claimBatch, releaseSlot, extendSlot, HEARTBEAT_INTERVAL_MS } from './parallel-executor.js'
import { logSprintHandoff } from '@plexo/agent/sprint/sprint-ledger'

const POLL_INTERVAL_MS = 2_000
const API_COST_CEILING = parseFloat(process.env.API_COST_CEILING_USD ?? '10')

let running = true
let activeTasks: Map<string, AbortController> = new Map()
let sessionCount = 0
let lastActivity: string | null = null

/**
 * Returns the current agent loop status snapshot.
 * Used by GET /api/v1/agent/status to serve real data.
 */
export function getAgentStatus(): {
    activeTaskId: string | null
    currentModel: string | null
    sessionCount: number
    lastActivity: string | null
} {
    const firstActive = Array.from(activeTasks.keys())[0] ?? null
    return { activeTaskId: firstActive, currentModel: null, sessionCount, lastActivity }
}

/**
 * Returns detailed agent health data including ghost task detection.
 * Ghost tasks: status = 'running' but claimed_at older than 3 minutes.
 */
export async function getAgentHealth(): Promise<{
    activeSlots: number
    maxSlots: number
    queueDepth: number
    ghostTasks: string[]
    pollIntervalMs: number
    activeTasks: string[]
}> {
    const { getParallelStatus } = await import('./parallel-executor.js')
    const slotStatus = await getParallelStatus()

    // Count queued tasks
    const [queueRow] = await db.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(eq(tasks.status, 'queued'))

    // Find ghost tasks: running for > 3 minutes with no active in-memory handle
    const ghostRows = await db.select({ id: tasks.id })
        .from(tasks)
        .where(sql`${tasks.status} = 'running' AND ${tasks.claimedAt} < NOW() - INTERVAL '3 minutes'`)

    return {
        activeSlots: slotStatus.slots.length,
        maxSlots: slotStatus.maxSlots,
        queueDepth: Number(queueRow?.count ?? 0),
        ghostTasks: ghostRows.map(r => r.id),
        pollIntervalMs: POLL_INTERVAL_MS,
        activeTasks: Array.from(activeTasks.keys()),
    }
}

/**
 * Abort the currently-running task if it matches the given id.
 * Called by DELETE /api/v1/tasks/:id so the executor stops at the
 * next signal-check boundary instead of finishing the current step.
 */
export function cancelActiveTask(taskId: string): boolean {
    const abort = activeTasks.get(taskId)
    if (!abort) return false
    abort.abort()
    logger.info({ taskId }, 'Active task abort signalled via cancelActiveTask')
    return true
}

/**
 * Load workspace AI settings and resolve the first usable credential.
 * Checks the full fallback chain (primary → fallbacks) so that if Anthropic
 * isn't configured but OpenAI is, the task proceeds and withFallback() in
 * the executor handles provider selection.
 */
export async function loadWorkspaceAISettings(workspaceId: string): Promise<{
    credential: AnthropicCredential | null
    aiSettings: WorkspaceAISettings | null
}> {
    if (!workspaceId) {
        logger.warn('loadWorkspaceAISettings called with no workspaceId')
        return { credential: null, aiSettings: null }
    }

    let aiSettings: WorkspaceAISettings | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawProviders: Record<string, any> = {}

    try {
        const ap = await loadDecryptedAIProviders(workspaceId)

        if (!ap) {
            logger.warn({ workspaceId }, 'ai-cred: no aiProviders in workspace settings — never saved?')
        } else {
            rawProviders = ap.providers ?? {}
            const providerKeys = Object.keys(rawProviders)
            // Log what's actually in the DB without exposing key values
            const providerSummary = Object.fromEntries(
                providerKeys.map((k) => {
                    const p = rawProviders[k]
                    return [k, {
                        status: p.status ?? 'missing',
                        hasApiKey: !!(p.apiKey),
                        hasBaseUrl: !!(p.baseUrl),
                        selectedModel: p.selectedModel ?? p.defaultModel ?? null,
                    }]
                })
            )
            logger.info({
                workspaceId,
                primary: ap.primary ?? ap.primaryProvider ?? '(none)',
                fallbackOrder: ap.fallbackOrder ?? ap.fallbackChain ?? [],
                providers: providerSummary,
            }, 'ai-cred: workspace AI settings loaded from DB')

            aiSettings = {
                inferenceMode: ap.inferenceMode as WorkspaceAISettings['inferenceMode'],
                // No Anthropic default — if no primary is set the workspace is not configured
                primaryProvider: (ap.primary ?? ap.primaryProvider) as ProviderKey,
                fallbackChain: (ap.fallbackOrder ?? ap.fallbackChain ?? []) as ProviderKey[],
                providers: Object.fromEntries(
                    providerKeys.map((k) => {
                        const p = rawProviders[k]
                        return [k, {
                            provider: k as ProviderKey,
                            apiKey: p.apiKey,
                            baseUrl: p.baseUrl,
                            status: p.status,
                            model: p.selectedModel ?? p.defaultModel,
                        }]
                    })
                ) as WorkspaceAISettings['providers'],
            }
        }
    } catch (err) {
        logger.error({ err, workspaceId }, 'ai-cred: failed to load workspace settings from DB')
    }

    // Per-provider env var names — used as last-resort fallback when a provider
    // is configured by the user (in their chain) but has no DB key yet.
    // This allows operators to pre-seed keys via env without requiring a UI setup.
    // Priority is always the user's configured primaryProvider and fallbackChain.
    const PROVIDER_ENV_VARS: Partial<Record<string, string>> = {
        anthropic: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        openrouter: process.env.OPENROUTER_API_KEY,
        google: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
        mistral: process.env.MISTRAL_API_KEY,
        groq: process.env.GROQ_API_KEY,
        xai: process.env.XAI_API_KEY,
        deepseek: process.env.DEEPSEEK_API_KEY,
    }

    const isValidApiKey = (k: string) => k !== 'placeholder' && k.length > 10 && !k.includes(' ')

    // Walk the full provider chain from workspace DB settings.
    // First provider with a usable credential wins.
    // If no primary is configured at all, we have nothing to fall back on.
    if (!aiSettings?.primaryProvider) {
        logger.warn({ workspaceId }, 'ai-cred: ✗ no primary provider configured for workspace')
        return { credential: null, aiSettings }
    }

    const primaryProvider = aiSettings.primaryProvider
    const fallbackChain = aiSettings.fallbackChain ?? []
    const chain = [primaryProvider, ...fallbackChain.filter((p) => p !== primaryProvider)]

    logger.info({ workspaceId, chain }, 'ai-cred: walking provider chain')

    function withPrimary(key: string, credential: AnthropicCredential): { credential: AnthropicCredential; aiSettings: WorkspaceAISettings | null } {
        if (aiSettings && aiSettings.primaryProvider !== key) {
            logger.info({ workspaceId, from: aiSettings.primaryProvider, to: key }, 'ai-cred: pinning primaryProvider to working provider')
            aiSettings = { ...aiSettings, primaryProvider: key as ProviderKey }
        }
        return { credential, aiSettings }
    }

    for (const providerKey of chain) {
        // Respect user-level enable/disable toggle
        const p = rawProviders[providerKey]
        if (p?.enabled === false) {
            logger.info({ workspaceId, providerKey }, 'ai-cred: provider disabled by user — skip')
            continue
        }

        const apiKey = p?.apiKey as string | undefined
        const baseUrl = p?.baseUrl as string | undefined
        const status = p?.status as string | undefined

        // 1. DB-stored API key
        if (apiKey && isValidApiKey(apiKey)) {
            logger.info({ workspaceId, providerKey }, 'ai-cred: ✓ API key found in DB')
            return withPrimary(providerKey, { type: 'api_key', apiKey })
        }

        // 2. Keyless provider (Ollama, configured status)
        if (status === 'configured' || baseUrl) {
            logger.info({ workspaceId, providerKey, baseUrl }, 'ai-cred: ✓ keyless provider (configured/baseUrl)')
            return withPrimary(providerKey, { type: 'api_key', apiKey: 'local' })
        }

        // 3. Per-provider env var fallback (only if the user has this provider in their chain)
        const envKey = PROVIDER_ENV_VARS[providerKey]
        if (envKey && isValidApiKey(envKey)) {
            logger.info({ workspaceId, providerKey }, 'ai-cred: ✓ using env var fallback for configured provider')
            // Inject the env key into aiSettings so the executor has an explicit apiKey
            if (aiSettings) {
                aiSettings = {
                    ...aiSettings,
                    providers: {
                        ...aiSettings.providers,
                        [providerKey]: {
                            ...(aiSettings.providers?.[providerKey as ProviderKey] ?? { provider: providerKey as ProviderKey }),
                            apiKey: envKey,
                            enabled: true,
                        },
                    },
                }
            }
            return withPrimary(providerKey, { type: 'api_key', apiKey: envKey })
        }

        logger.debug({ workspaceId, providerKey, status, hasApiKey: !!apiKey }, 'ai-cred: no usable credential, skip')
    }

    logger.warn({ workspaceId, chain }, 'ai-cred: ✗ no usable credential found in any provider — task will be blocked')
    return { credential: null, aiSettings }
}

async function buildTaskContext(task: typeof tasks.$inferSelect): Promise<void> {
    const taskStartMs = Date.now()

    logger.info({ taskId: task.id, type: task.type }, 'Task claimed')

    // Telemetry: agent run started — task claimed, before execution begins
    try {
        const { emitAgentRunStarted } = await import('./telemetry/events.js')
        emitAgentRunStarted({
            taskType: task.type ?? 'unknown',
            source: task.source ?? 'unknown',
            modelFamily: 'unknown', // resolved later after credential loading
        })
    } catch { /* telemetry must never crash the app */ }

    // Use workspace-scoped emit so SSE and channel adapters receive it
    emitToWorkspace(task.workspaceId ?? (task as Record<string, unknown>)['workspace_id'] as string ?? '', { type: 'task_started', taskId: task.id, taskType: task.type })

    // claimTask uses raw SQL (RETURNING *) which returns snake_case column names,
    // not camelCase Drizzle mappings. Handle both to be safe.
    const taskWorkspaceId = task.workspaceId
        ?? (task as Record<string, unknown>)['workspace_id'] as string | undefined

    const { credential, aiSettings } = await loadWorkspaceAISettings(taskWorkspaceId ?? '')
    if (!credential) {
        await blockTask(task.id, 'No AI credential configured for workspace')
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'claimed', to: 'blocked', workspaceId: taskWorkspaceId, reason: 'no_ai_credential' }, 'lifecycle')
        emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_blocked', taskId: task.id, reason: 'No AI credential' })
        captureLifecycleEvent('task.blocked', 'warning', { taskId: task.id, reason: 'no_ai_credential', workspaceId: taskWorkspaceId })
        logger.warn({ taskId: task.id, workspaceId: taskWorkspaceId }, 'No credential — task blocked')
        await releaseSlot(task.id)
        return
    }

    // ── Pre-flight: workspace weekly ceiling ──────────────────────────────────
    // Check before claiming CPU/memory so we fail fast if already over budget.
    try {
        const [costRow] = await db
            .select({ costUsd: apiCostTracking.costUsd, ceilingUsd: apiCostTracking.ceilingUsd })
            .from(apiCostTracking)
            .where(eq(apiCostTracking.workspaceId, taskWorkspaceId ?? ''))
            .limit(1)

        if (costRow && costRow.costUsd >= costRow.ceilingUsd) {
            await blockTask(task.id, `Workspace weekly cost ceiling reached: $${costRow.costUsd.toFixed(4)} / $${costRow.ceilingUsd.toFixed(2)}`)
            emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_blocked', taskId: task.id, reason: 'WORKSPACE_COST_CEILING' })
            captureLifecycleEvent('task.blocked', 'warning', { taskId: task.id, reason: 'cost_ceiling', costUsd: costRow.costUsd, ceilingUsd: costRow.ceilingUsd, workspaceId: taskWorkspaceId })
            logger.warn({ taskId: task.id, costUsd: costRow.costUsd, ceilingUsd: costRow.ceilingUsd }, 'Workspace ceiling — task blocked')
            await releaseSlot(task.id)
            return
        }
    } catch (costErr) {
        logger.warn({ costErr }, 'Pre-flight cost check failed non-fatally — continuing')
    }

    // ── Single consolidated query: task budget + workspace context ──────────
    // Loads task budget, workspace settings (name, persona, cost defaults),
    // and sprint goal in parallel to avoid sequential DB round-trips.
    const [taskRow, wsRow, sprintRow] = await Promise.all([
        db.select({
            costCeilingUsd: tasks.costCeilingUsd,
            tokenBudget: tasks.tokenBudget,
            projectId: tasks.projectId,
        }).from(tasks).where(eq(tasks.id, task.id)).limit(1).then(r => r[0]),
        db.select({ name: workspaces.name, settings: workspaces.settings })
            .from(workspaces).where(eq(workspaces.id, taskWorkspaceId ?? '')).limit(1).then(r => r[0]),
        // Sprint goal — only if task has a projectId (checked below)
        (task.context as Record<string, unknown> | null)?.sprintId
            ? db.select({ request: sprints.request }).from(sprints)
                .where(eq(sprints.id, String((task.context as Record<string, unknown>).sprintId))).limit(1).then(r => r[0])
            : Promise.resolve(undefined),
    ])

    // Extract workspace settings once
    const wsSettings = (wsRow?.settings ?? {}) as Record<string, unknown>
    const wsAiProviders = wsSettings.aiProviders as Record<string, unknown> | undefined

    // Resolve budgets
    const wsDefaultCostCeiling = wsAiProviders?.defaultTaskCostCeiling ? Number(wsAiProviders.defaultTaskCostCeiling) || null : null
    const wsDefaultTokenBudget = wsAiProviders?.defaultTokenBudget ? Number(wsAiProviders.defaultTokenBudget) || null : null
    const resolvedCostCeiling = taskRow?.costCeilingUsd ?? wsDefaultCostCeiling
    const resolvedTokenBudget = taskRow?.tokenBudget ?? wsDefaultTokenBudget ?? 0

    // Merge ensemble quality-judge settings
    if (aiSettings) {
        const ensembleSize = wsSettings.ensembleSize != null ? Number(wsSettings.ensembleSize) : undefined
        const dissentThreshold = wsSettings.dissentThreshold != null ? Number(wsSettings.dissentThreshold) : undefined
        if (ensembleSize != null && !isNaN(ensembleSize)) aiSettings.ensembleSize = ensembleSize
        if (dissentThreshold != null && !isNaN(dissentThreshold)) aiSettings.dissentThreshold = dissentThreshold
    }

    // Extract workspace context
    let workspaceName = wsRow?.name ?? undefined
    let workspaceSummary: string | undefined
    let agentName: string | undefined
    let agentPersona: string | undefined
    let sprintGoal: string | undefined
    let sprintName: string | undefined
    let sprintWorkDir: string | undefined
    let sprintRepo: string | undefined
    let sprintBranch: string | undefined

    agentName = typeof wsSettings.agentName === 'string' ? wsSettings.agentName : workspaceName
    agentPersona = typeof wsSettings.agentPersona === 'string' ? wsSettings.agentPersona : undefined
    workspaceSummary = typeof wsSettings.agentTagline === 'string' ? wsSettings.agentTagline : undefined

    if (sprintRow) {
        sprintGoal = sprintRow.request ?? undefined
        sprintName = taskRow?.projectId ?? undefined
    } else if (taskRow?.projectId) {
        // Fallback: load sprint if not found via context.sprintId
        try {
            const [sr] = await db.select({ request: sprints.request }).from(sprints)
                .where(eq(sprints.id, taskRow.projectId)).limit(1)
            if (sr) { sprintGoal = sr.request ?? undefined; sprintName = taskRow.projectId }
        } catch { /* non-fatal */ }
    }

    // ── Sprint coding context: clone repo to temp dir for coding tasks ──────────
    // task.context is set by the sprint runner with { repo, branch, workspaceId, ... }
    // We clone here (agent-loop level) so the executor has a real working dir.
    if (task.type === 'coding') {
        const taskCtx = task.context as Record<string, unknown> | null | undefined
        const repo = taskCtx?.repo as string | undefined
        const branch = taskCtx?.branch as string | undefined
        const ctxWorkspaceId = (taskCtx?.workspaceId as string | undefined) ?? taskWorkspaceId

        if (repo && branch) {
            try {
                const { execSync } = await import('node:child_process')
                const { mkdtempSync } = await import('node:fs')
                const { join } = await import('node:path')
                const { tmpdir } = await import('node:os')

                // Resolve token from installed_connections or env
                const { resolveGitHubToken } = await import('@plexo/agent/github/client')
                const token = await resolveGitHubToken(ctxWorkspaceId).catch(() => process.env.GITHUB_TOKEN ?? '')

                const workDir = mkdtempSync(join(tmpdir(), 'plexo-sprint-'))
                const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`

                execSync(
                    `git clone --depth=1 --branch ${branch} ${cloneUrl} .`,
                    { cwd: workDir, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' },
                )
                logger.info({ taskId: task.id, repo, branch, workDir }, 'Sprint repo cloned')

                sprintWorkDir = workDir
                sprintRepo = repo
                sprintBranch = branch
                // Register for Code Mode file tree + SSE
                registerCodeContext(task.id, taskWorkspaceId ?? '', workDir)
            } catch (cloneErr) {
                // Non-fatal: executor falls back to process.cwd() which is wrong but at least
                // the task proceeds. The system prompt will tell the agent to clone manually.
                logger.warn({ taskId: task.id, err: cloneErr }, 'Sprint repo clone failed — executor will work without pre-cloned dir')
            }
        }
    }

    const abort = new AbortController()
    activeTasks.set(task.id, abort)
    sessionCount++
    lastActivity = new Date().toISOString()

    // Heartbeat: extend Redis slot TTL every 30s so expired slots are detected within ~90s
    const heartbeat = setInterval(
        () => void extendSlot(task.id).catch(e => logger.warn({ err: e, taskId: task.id }, 'heartbeat miss')),
        HEARTBEAT_INTERVAL_MS,
    )

    // Universal per-task workdir — every task gets an isolated temp directory
    const taskWorkDir = `/tmp/plexo-tasks/${task.id}`
    try {
        const { mkdirSync } = await import('node:fs')
        mkdirSync(taskWorkDir, { recursive: true })
    } catch { /* non-fatal — fall back to process.cwd() */ }

    // Per-task model override: task.context.modelOverrideId forces Mode 4 routing
    const taskContext0 = task.context as Record<string, unknown> | null | undefined
    const modelOverrideId = typeof taskContext0?.modelOverrideId === 'string' && taskContext0.modelOverrideId
        ? taskContext0.modelOverrideId
        : undefined

    const sprintId: string | undefined = taskRow?.projectId ?? undefined

    const ctx: ExecutionContext = {
        taskId: task.id,
        workspaceId: taskWorkspaceId ?? '',
        userId: 'system',
        credential,
        taskType: task.type as import('@plexo/agent/types').TaskType ?? 'coding',
        tokenBudget: resolvedTokenBudget,
        taskCostCeilingUsd: resolvedCostCeiling,
        signal: abort.signal,
        // Phase A: workspace + persona context
        workspaceName,
        agentName,
        agentPersona,
        workspaceSummary,
        sprintGoal,
        sprintName,
        // Runtime identity — resolved provider/model so executor knows who it is
        activeProvider: aiSettings?.primaryProvider ?? 'openai',
        activeModel: (aiSettings?.providers as Record<string, { model?: string } | undefined> | undefined)
            ?.[aiSettings?.primaryProvider ?? 'openai']?.model ?? 'gpt-4o',
        // Per-task override (Mode 4): forces this model ID over workspace settings
        modelOverrideId,
        // Sprint coding context
        sprintWorkDir,
        sprintRepo,
        sprintBranch,
        sprintId,
        // Live event streaming to SSE clients — enabled for all tasks (Phase 2)
        emitStepEvent: (event) => emitToWorkspace(taskWorkspaceId ?? '', event as unknown as import('./sse-emitter.js').AgentEvent),
    }

    try {
        await db.update(tasks)
            .set({ status: 'running', claimedAt: new Date() })
            .where(eq(tasks.id, task.id))
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'claimed', to: 'running', workspaceId: taskWorkspaceId }, 'lifecycle')

        const taskContext = task.context as Record<string, unknown>
        const description = (taskContext.description as string)
            ?? (taskContext.message as string)
            ?? JSON.stringify(taskContext)

        // Fast-path: skip the planner LLM call for simple tasks (< 200 chars, no special context).
        // The planner adds 5-15 seconds of latency for a second LLM round-trip that produces
        // a trivial 1-step plan for simple requests. Only run the full planner for complex tasks.
        const isSimpleTask = description.length < 200
            && !taskContext.repo
            && !taskContext.sprintTaskId
            && !description.toLowerCase().includes('project')
            && !description.toLowerCase().includes('migration')
            && !description.toLowerCase().includes('deploy')

        let plannerResult: Awaited<ReturnType<typeof planTask>>

        if (isSimpleTask) {
            // Synthetic plan — no LLM call needed
            logger.info({ taskId: task.id }, 'Fast-path: skipping planner for simple task')
            emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_planned', taskId: task.id, steps: 1, confidence: 0.9 })
            plannerResult = {
                type: 'plan',
                plan: {
                    taskId: task.id,
                    goal: description,
                    steps: [{ stepNumber: 1, description, toolsRequired: [], verificationMethod: 'Review output', isOneWayDoor: false }],
                    oneWayDoors: [],
                    estimatedDurationMs: 30000,
                    confidenceScore: 0.9,
                    risks: [],
                },
            }
        } else {
            emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_planning', taskId: task.id })
            logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'running', to: 'planning', workspaceId: taskWorkspaceId }, 'lifecycle')
            plannerResult = await planTask(ctx, description, taskContext, aiSettings ?? undefined)
        }

        // Phase D: capability pre-flight — planner returned a clarification request
        if (plannerResult.type === 'clarification') {
            logger.info({ taskId: task.id, alternatives: plannerResult.alternatives.length }, 'Planner returned clarification — capability gap detected')
            logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'planning', to: 'blocked', workspaceId: taskWorkspaceId, reason: 'clarification_needed' }, 'lifecycle')
            captureLifecycleEvent('task.blocked', 'info', { taskId: task.id, reason: 'clarification_needed', alternatives: plannerResult.alternatives.length, workspaceId: taskWorkspaceId })
            await blockTask(task.id, plannerResult.message)
            // Store clarification payload so UI + channels can surface alternatives
            await db.update(tasks).set({
                context: sql`context || ${JSON.stringify({ _clarification: plannerResult })}::jsonb`,
            }).where(eq(tasks.id, task.id))
            emitToWorkspace(taskWorkspaceId ?? '', {
                type: 'task_clarification_needed' as 'task_blocked',
                taskId: task.id,
                reason: plannerResult.message,
            })
            return
        }

        const plan = plannerResult.plan
        logger.info({ taskId: task.id, steps: plan.steps.length, confidence: plan.confidenceScore }, 'Plan ready')
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'planning', to: 'executing', workspaceId: taskWorkspaceId, steps: plan.steps.length }, 'lifecycle')
        emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_planned', taskId: task.id, steps: plan.steps.length, confidence: plan.confidenceScore })

        if (plan.oneWayDoors.length > 0) {
            logger.warn({ taskId: task.id, doors: plan.oneWayDoors.length }, 'One-way doors detected — auto-approving in Phase 2')
        }

        // Pass workspace AI settings so executeTask uses the configured provider fallback chain
        const result = await executeTask(ctx, plan, aiSettings ?? undefined)
        logger.info({ taskId: task.id, ok: result.ok, cost: result.totalCostUsd }, 'Task executed')

        await completeTask(task.id, {
            qualityScore: result.qualityScore,
            outcomeSummary: result.outcomeSummary,
            tokensIn: result.totalTokensIn,
            tokensOut: result.totalTokensOut,
            costUsd: result.totalCostUsd,
        })
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'running', to: 'complete', workspaceId: taskWorkspaceId, durationMs: Date.now() - taskStartMs, costUsd: result.totalCostUsd }, 'lifecycle')

        // Telemetry: if this is the workspace's first completed task, emit onboarding_completed
        try {
            const { emitOnboardingCompleted } = await import('./telemetry/events.js')
            const [completedCount] = await db.select({ count: sql<number>`count(*)` })
                .from(tasks)
                .where(sql`${tasks.workspaceId} = ${taskWorkspaceId} AND ${tasks.status} = 'complete'`)
            if (Number(completedCount?.count ?? 0) === 1) {
                // First ever completed task — compute duration from workspace creation
                const [wsCreated] = await db.select({ createdAt: workspaces.createdAt })
                    .from(workspaces).where(eq(workspaces.id, taskWorkspaceId ?? '')).limit(1)
                const durationMs = wsCreated?.createdAt
                    ? Date.now() - new Date(wsCreated.createdAt).getTime()
                    : Date.now() - taskStartMs
                emitOnboardingCompleted({ durationMs })
            }
        } catch { /* telemetry must never crash the app */ }

        // ── Cost accounting ────────────────────────────────────────────────────
        // Canonical write point for api_cost_tracking — agent-loop is the only writer.
        // executor/index.ts explicitly does NOT write this table to avoid double-counting.
        // Uses Postgres date_trunc to avoid JS timezone drift in week_start calculation.
        if (result.totalCostUsd > 0) {
            try {
                await db.execute(sql`
                    INSERT INTO api_cost_tracking (id, workspace_id, week_start, cost_usd, ceiling_usd, alerted_80)
                    VALUES (
                        gen_random_uuid(),
                        ${taskWorkspaceId ?? ''}::uuid,
                        date_trunc('week', NOW())::date,
                        ${result.totalCostUsd},
                        ${API_COST_CEILING},
                        false
                    )
                    ON CONFLICT (workspace_id, week_start)
                    DO UPDATE SET
                        cost_usd = api_cost_tracking.cost_usd + EXCLUDED.cost_usd,
                        alerted_80 = CASE
                            WHEN (api_cost_tracking.cost_usd + EXCLUDED.cost_usd) >= (api_cost_tracking.ceiling_usd * 0.8)
                            THEN true
                            ELSE api_cost_tracking.alerted_80
                        END
                `)
                logger.info({ taskId: task.id, costUsd: result.totalCostUsd }, 'api_cost_tracking updated')
            } catch (costWriteErr) {
                logger.warn({ err: costWriteErr, taskId: task.id }, 'api_cost_tracking upsert failed — non-fatal')
            }
        } else {
            logger.debug({ taskId: task.id }, 'api_cost_tracking: zero-cost task, skipping upsert')
        }

        // work_ledger is written by executor/index.ts (richer row with deliverables + wall_clock_ms).
        // Do NOT write here — that was double-counted. agent-loop only owns api_cost_tracking.

        // ── Task memory ────────────────────────────────────────────────────────
        // Store a semantic memory entry so the Intelligence page has entries to show
        // and future tasks can retrieve relevant past context.
        try {
            const taskCtxForMem = task.context as Record<string, unknown> | null | undefined
            const description = (taskCtxForMem?.description as string)
                ?? (taskCtxForMem?.message as string)
                ?? task.type
            await recordTaskMemory({
                workspaceId: taskWorkspaceId ?? '',
                taskId: task.id,
                description,
                outcome: result.ok ? 'success' : 'partial',
                toolsUsed: [],  // executor doesn't currently expose tool list in result
                qualityScore: result.qualityScore,
                notes: result.outcomeSummary?.slice(0, 300),
                aiSettings: aiSettings ?? undefined,
            })
        } catch (memErr) {
            logger.warn({ err: memErr, taskId: task.id }, 'recordTaskMemory failed — non-fatal')
        }

        // ── Sprint task sync (CRITICAL) ────────────────────────────────────────
        // The sprint runner polls sprint_tasks.status to detect wave completion.
        // agent-loop only updates `tasks` — we must also mirror status into sprint_tasks.
        try {
            const taskCtxForSprint = task.context as Record<string, unknown> | null | undefined
            const sprintTaskId = taskCtxForSprint?.sprintTaskId as string | undefined
            if (sprintTaskId) {
                await db.update(sprintTasks)
                    .set({
                        status: 'complete',
                        completedAt: new Date(),
                        handoff: sql`COALESCE(handoff, '{}'::jsonb) || ${JSON.stringify({ outcome: result.outcomeSummary.slice(0, 2000) })}::jsonb`,
                    })
                    .where(eq(sprintTasks.id, sprintTaskId))
                logger.info({ taskId: task.id, sprintTaskId }, 'Sprint task marked complete')
                
                // Track handoff quality for intelligence
                await logSprintHandoff({
                    sprintId: String(taskCtxForSprint?.sprintId ?? sprintTaskId),
                    taskId: sprintTaskId,
                    summary: result.outcomeSummary,
                    filesChanged: [], // Cannot natively trace all files here easily without diffing
                    concerns: [],
                    suggestions: [],
                    tokensUsed: (result.totalTokensIn ?? 0) + (result.totalTokensOut ?? 0),
                    toolCalls: result.steps?.length ?? 1,
                    durationMs: Date.now() - taskStartMs,
                })
            }
        } catch (stErr) {
            logger.warn({ err: stErr, taskId: task.id }, 'Failed to update sprint_tasks status — non-fatal')
        }

        // Persist judge metadata into context JSONB so the task detail UI can display it.
        const extResult = result as typeof result & { judgeMeta?: Record<string, unknown> }
        if (extResult.judgeMeta) {
            await db.update(tasks).set({
                context: sql`context || ${JSON.stringify({ _judge: extResult.judgeMeta })}::jsonb`,
            }).where(eq(tasks.id, task.id))
        }

        emitTaskOutcome({
            type: task.type ?? 'unknown',
            source: task.source ?? 'unknown',
            success: result.ok,
            durationMs: Date.now() - taskStartMs,
            costUsd: result.totalCostUsd,
            provider: ctx.activeProvider,
            stepCount: result.steps?.length ?? plan.steps.length,
        })

        // Fetch assets to include in event
        let assets: string[] = []
        try {
            const { readdirSync, existsSync } = await import('node:fs')
            const dir = `/tmp/plexo-assets/${task.id}`
            if (existsSync(dir)) {
                assets = readdirSync(dir)
            }
        } catch { /* skip */ }

        emitToWorkspace(taskWorkspaceId ?? '', {
            type: 'task_complete',
            taskId: task.id,
            qualityScore: result.qualityScore,
            costUsd: result.totalCostUsd,
            summary: result.outcomeSummary,
            assets,
        })

        // Persistent channel delivery — delivers results to originating channel (Telegram, etc.)
        // This is the DB-backed delivery path that survives process restarts.
        const originCtx = (task.context as Record<string, unknown>) ?? {}
        if (originCtx.channel && originCtx.chatId) {
            const { deliverToOriginChannel } = await import('./channel-delivery.js')
            void deliverToOriginChannel({
                taskId: task.id,
                workspaceId: taskWorkspaceId ?? '',
                context: originCtx as any,
                summary: result.outcomeSummary ?? 'Task completed.',
                assets,
                outcome: 'complete',
            }).catch(err => logger.warn({ err, taskId: task.id }, 'Channel delivery failed'))
        }
        captureLifecycleEvent('task.complete', 'info', {
            taskId: task.id,
            type: task.type,
            source: task.source,
            durationMs: Date.now() - taskStartMs,
            costUsd: result.totalCostUsd,
            qualityScore: result.qualityScore,
        })
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ taskId: task.id, err }, 'Task failed')
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'running', to: 'failed', workspaceId: taskWorkspaceId, durationMs: Date.now() - taskStartMs, error: message.slice(0, 200) }, 'lifecycle')
        captureLifecycleEvent('task.failed', 'error', { taskId: task.id, error: message, workspaceId: taskWorkspaceId })
        await blockTask(task.id, message)

        // Persistent channel delivery for failures
        const failContext = (task.context as Record<string, unknown>) ?? {}
        if (failContext.channel && failContext.chatId) {
            const { deliverToOriginChannel } = await import('./channel-delivery.js')
            void deliverToOriginChannel({
                taskId: task.id,
                workspaceId: taskWorkspaceId ?? '',
                context: failContext as any,
                summary: '',
                error: message.slice(0, 500),
                outcome: 'failed',
            }).catch(e => logger.warn({ e, taskId: task.id }, 'Channel failure delivery failed'))
        }

        emitTaskOutcome({
            type: task.type ?? 'unknown',
            source: task.source ?? 'unknown',
            success: false,
            durationMs: Date.now() - taskStartMs,
            costUsd: 0,
            provider: ctx.activeProvider,
            stepCount: 0,
        })

        // ── Sprint task sync on failure ────────────────────────────────────
        try {
            const taskCtxForSprint = task.context as Record<string, unknown> | null | undefined
            const sprintTaskId = taskCtxForSprint?.sprintTaskId as string | undefined
            if (sprintTaskId) {
                await db.update(sprintTasks)
                    .set({
                        status: 'failed',
                        handoff: sql`COALESCE(handoff, '{}'::jsonb) || ${JSON.stringify({ outcome: message.slice(0, 2000) })}::jsonb`,
                    })
                    .where(eq(sprintTasks.id, sprintTaskId))
                logger.info({ taskId: task.id, sprintTaskId }, 'Sprint task marked failed')
            }
        } catch (stErr) {
            logger.warn({ err: stErr, taskId: task.id }, 'Failed to update sprint_tasks status (fail) — non-fatal')
        }

        emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_failed', taskId: task.id, error: message })
        captureLifecycleEvent('task.failed', 'error', {
            taskId: task.id,
            type: task.type,
            source: task.source,
            durationMs: Date.now() - taskStartMs,
            error: message.slice(0, 500),
        })
    } finally {
        clearInterval(heartbeat)
        activeTasks.delete(task.id)

        // Release Redis slot
        await releaseSlot(task.id)
        // Deregister Code Mode context
        unregisterCodeContext(task.id)
        // Clean up cloned repo temp dir for coding tasks
        if (sprintWorkDir) {
            try {
                const { rmSync } = await import('node:fs')
                rmSync(sprintWorkDir, { recursive: true, force: true })
                logger.debug({ taskId: task.id, sprintWorkDir }, 'Sprint work dir cleaned up')
            } catch { /* non-fatal */ }
        }
        // Clean up universal task workdir
        try {
            const { rmSync } = await import('node:fs')
            rmSync(taskWorkDir, { recursive: true, force: true })
        } catch { /* non-fatal */ }
    }

}

/** Cancel stale blocked/queued tasks older than 7 days so they stop cluttering the dashboard. */
async function cleanupStaleTasks(): Promise<void> {
    try {
        const result = await db.execute(sql`
            UPDATE tasks
            SET status = 'cancelled',
                outcome_summary = COALESCE(outcome_summary, 'Auto-cancelled: stale after 7 days')
            WHERE status IN ('blocked', 'queued')
              AND created_at < NOW() - INTERVAL '7 days'
            RETURNING id
        `)
        const count = Array.isArray(result) ? result.length : 0
        if (count > 0) logger.info({ count }, 'Cleaned up stale blocked/queued tasks')
    } catch (err) {
        logger.warn({ err }, 'Stale task cleanup failed — non-fatal')
    }
}

/**
 * Active ghost task recovery — catches running tasks whose slot expired
 * but weren't picked up by claimBatch's passive eviction. Runs every 5 minutes.
 */
async function recoverGhostTasks(): Promise<void> {
    try {
        const ghosts = await db.execute<{ id: string }>(sql`
            SELECT id FROM tasks
            WHERE status = 'running'
              AND claimed_at < NOW() - INTERVAL '3 minutes'
        `)
        for (const ghost of ghosts) {
            // Only requeue if not actively tracked in this process
            if (!activeTasks.has(ghost.id)) {
                const result = await db.execute<{ id: string; attempt_count: number }>(sql`
                    UPDATE tasks
                    SET attempt_count = COALESCE(attempt_count, 0) + 1,
                        status = CASE
                            WHEN COALESCE(attempt_count, 0) + 1 >= 3 THEN 'blocked'::task_status
                            ELSE 'queued'::task_status
                        END,
                        outcome_summary = CASE
                            WHEN COALESCE(attempt_count, 0) + 1 >= 3
                            THEN 'Failed after ' || (COALESCE(attempt_count, 0) + 1) || ' attempts (ghost task recovery)'
                            ELSE outcome_summary
                        END,
                        claimed_at = NULL
                    WHERE id = ${ghost.id} AND status = 'running'
                    RETURNING id, attempt_count
                `)
                if (result.length > 0) {
                    const row = result[0]!
                    const newStatus = (row.attempt_count ?? 0) >= 3 ? 'blocked' : 'queued'
                    logger.info({ event: 'task.lifecycle', taskId: ghost.id, from: 'running', to: newStatus, attemptCount: row.attempt_count, reason: 'ghost_recovery' }, 'lifecycle')
                }
            }
        }
    } catch (err) {
        logger.warn({ err }, 'Ghost task recovery failed — non-fatal')
    }
}

export function startAgentLoop(): void {
    logger.info('Agent queue loop started')

    // Clean up stale blocked tasks at startup + every 6 hours
    void cleanupStaleTasks()
    setInterval(() => { void cleanupStaleTasks() }, 6 * 60 * 60 * 1000)

    // Ghost task recovery — every 5 minutes
    void recoverGhostTasks()
    setInterval(() => { void recoverGhostTasks() }, 5 * 60 * 1000)

    async function poll(): Promise<void> {
        while (running) {
            try {
                // Claim batch handles limits internally
                const batch = await claimBatch()
                if (batch.length > 0) {
                    logger.info({ batchSize: batch.length, msg: 'Starting batch execution' })
                    // Fire-and-forget, the promise settles in background, poll loop continues immediately
                    // The Claim step ensures we won't oversubscribe
                    for (const t of batch) {
                        void buildTaskContext(t).catch(e => logger.error({ err: e }, 'Task wrapper error'))
                    }
                }
            } catch (err) {
                logger.error({ err }, 'Queue loop error (batch claim)')
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        }
    }

    void poll().catch((err) => logger.fatal({ err }, 'Agent loop crashed'))
}

export function stopAgentLoop(): void {
    running = false
    for (const abort of activeTasks.values()) {
        abort.abort()
    }
    logger.info('Agent queue loop stopped')
}
