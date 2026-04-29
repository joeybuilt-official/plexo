// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { claimTask, completeTask, blockTask, failTask, requeueForRetry } from '@plexo/queue'
import { db, eq, and, sql, inArray } from '@plexo/db'
import { tasks, apiCostTracking, workspaces, sprints, sprintTasks, plexoOpsTaskEvents } from '@plexo/db'
import { planTask } from '@plexo/agent/planner'
import { executeTask } from '@plexo/agent/executor'
import { recordTaskMemory } from '@plexo/agent/memory/store'
import { reflectAndPromote } from '@plexo/agent/behavior/reflect'
import type { AnthropicCredential, ExecutionContext } from '@plexo/agent/types'
import { emitToWorkspace } from './sse-emitter.js'
import { registerCodeContext, unregisterCodeContext } from './routes/code.js'
import { emitTaskOutcome, emitReflectionEvent, emitSclMutate, emitSclDriftWarning } from './analytics/events.js'
import { trackError, trackEvent } from './event-tracker.js'
import type { WorkspaceAISettings, ProviderKey, AIProviderConfig } from '@plexo/agent/providers/registry'
import { logger } from './logger.js'

import { loadDecryptedAIProviders } from './routes/ai-provider-creds.js'
import { getDecryptedBraveKey } from './routes/search.js'
import { claimBatch, releaseSlot, extendSlot, HEARTBEAT_INTERVAL_MS } from './parallel-executor.js'
import { logSprintHandoff } from '@plexo/agent/sprint/sprint-ledger'
import { getCachedIntelligenceSettings, type IntelligenceSettings } from './lib/intelligence-cache.js'

const POLL_INTERVAL_MS = 2_000
const API_COST_CEILING = parseFloat(process.env.API_COST_CEILING_USD ?? '50')

let running = true
let activeTasks: Map<string, AbortController> = new Map()
let sessionCount = 0
let lastActivity: string | null = null

async function recordTaskEvent(params: {
    workspaceId: string
    taskId: string
    eventType: string
    fromState: string | null
    toState: string
    metadata?: Record<string, unknown>
}): Promise<void> {
    try {
        await db.insert(plexoOpsTaskEvents).values({
            workspaceId: params.workspaceId,
            taskId: params.taskId,
            eventType: params.eventType,
            fromState: params.fromState,
            toState: params.toState,
            metadata: params.metadata ?? {},
        })
    } catch (err) {
        logger.debug({ err, taskId: params.taskId }, 'failed to record task event')
    }
}

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

    // Try provider_instances table first (canonical source after Intelligence page migration)
    try {
        const { loadSettingsFromInstances } = await import('@plexo/agent/providers/settings-from-instances')
        const instanceSettings = await loadSettingsFromInstances(workspaceId)
        if (instanceSettings) {
            aiSettings = instanceSettings
            // Build rawProviders for the credential walk below
            for (const [k, v] of Object.entries(instanceSettings.providers) as [string, AIProviderConfig][]) {
                if (v) rawProviders[k] = { apiKey: v.apiKey, baseUrl: v.baseUrl, status: v.apiKey || v.baseUrl ? 'configured' : 'unconfigured', selectedModel: v.model, enabled: v.enabled }
            }
            logger.info({ workspaceId, source: 'provider_instances', primary: instanceSettings.primaryProvider }, 'ai-cred: settings loaded from provider_instances')
        }
    } catch (err) {
        logger.debug({ err, workspaceId }, 'ai-cred: provider_instances load failed — falling back to vault/arbiter')
    }

    // Fallback: vault/arbiter JSONB (legacy path, pre-migration workspaces)
    if (!aiSettings) {
        try {
            const ap = await loadDecryptedAIProviders(workspaceId)

            if (!ap) {
                logger.warn({ workspaceId }, 'ai-cred: no aiProviders in workspace settings — never saved?')
            } else {
                rawProviders = ap.providers ?? {}
                const providerKeys = Object.keys(rawProviders)
                logger.info({
                    workspaceId,
                    source: 'vault/arbiter',
                    primary: ap.primary ?? ap.primaryProvider ?? '(none)',
                }, 'ai-cred: settings loaded from vault/arbiter (legacy)')

                aiSettings = {
                    inferenceMode: ap.inferenceMode as WorkspaceAISettings['inferenceMode'],
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
        together: process.env.TOGETHER_API_KEY,
        fireworks: process.env.FIREWORKS_API_KEY,
        perplexity: process.env.PERPLEXITY_API_KEY,
        cerebras: process.env.CEREBRAS_API_KEY,
        sambanova: process.env.SAMBANOVA_API_KEY,
        cohere: process.env.COHERE_API_KEY,
        cloudflare: process.env.CLOUDFLARE_API_TOKEN,
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

/**
 * DI-006: Generalized sprint_tasks status sync.
 * Maps task statuses to the sprint_task_status enum:
 *   complete → complete, failed → failed, blocked → failed, cancelled → failed
 * Sprint tasks have no 'blocked' or 'cancelled' enum values so both map to 'failed'.
 */
async function syncSprintTaskStatus(
    task: typeof tasks.$inferSelect,
    targetStatus: 'complete' | 'failed',
    reason: string,
): Promise<void> {
    try {
        const ctx = task.context as Record<string, unknown> | null | undefined
        const sprintTaskId = ctx?.sprintTaskId as string | undefined
        if (sprintTaskId) {
            await db.update(sprintTasks)
                .set({
                    status: targetStatus,
                    ...(targetStatus === 'complete' ? { completedAt: new Date() } : {}),
                    handoff: sql`COALESCE(handoff, '{}'::jsonb) || ${JSON.stringify({ outcome: reason.slice(0, 2000) })}::jsonb`,
                })
                .where(eq(sprintTasks.id, sprintTaskId))
            logger.info({ taskId: task.id, sprintTaskId, targetStatus }, 'Sprint task status synced')
        }
    } catch (err) {
        logger.warn({ err, taskId: task.id }, 'Failed to sync sprint_tasks status — non-fatal')
    }
}

/** Compat wrapper — older call sites pass (task, reason) for blocked tasks */
async function syncSprintTaskBlocked(task: typeof tasks.$inferSelect, reason: string): Promise<void> {
    await syncSprintTaskStatus(task, 'failed', `Blocked: ${reason}`)
}

async function buildTaskContext(task: typeof tasks.$inferSelect): Promise<void> {
    const taskStartMs = Date.now()

    logger.info({ taskId: task.id, type: task.type }, 'Task claimed')

    // Analytics: agent run started — task claimed, before execution begins
    try {
        const { emitAgentRunStarted } = await import('./analytics/events.js')
        emitAgentRunStarted({
            taskType: task.type ?? 'unknown',
            source: task.source ?? 'unknown',
            modelFamily: 'unknown', // resolved later after credential loading
        })
    } catch { /* analytics must never crash the app */ }

    // Use workspace-scoped emit so SSE and channel adapters receive it
    emitToWorkspace(task.workspaceId ?? (task as Record<string, unknown>)['workspace_id'] as string ?? '', { type: 'task_started', taskId: task.id, taskType: task.type })

    // claimTask uses raw SQL (RETURNING *) which returns snake_case column names,
    // not camelCase Drizzle mappings. Handle both to be safe.
    const taskWorkspaceId = task.workspaceId
        ?? (task as Record<string, unknown>)['workspace_id'] as string | undefined

    // Start periodic progress updates for channel-originated tasks
    const originCtxForProgress = (task.context as Record<string, unknown>) ?? {}
    // Use a mutable container to hold the stopper across async closures without TypeScript narrowing issues
    const _progressStopper: { stop: (() => void) | null } = { stop: null }
    if (originCtxForProgress.channel) {
        import('./channel-delivery.js').then(({ startTaskProgressUpdates }) => {
            _progressStopper.stop = startTaskProgressUpdates(task.id, taskWorkspaceId ?? '', originCtxForProgress as any)
        }).catch(() => {})
    }

    const { credential, aiSettings } = await loadWorkspaceAISettings(taskWorkspaceId ?? '')
    if (!credential) {
        await failTask(task.id, 'No AI credential configured for workspace')
        await syncSprintTaskBlocked(task, 'No AI credential configured for workspace')
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'claimed', to: 'failed', workspaceId: taskWorkspaceId, reason: 'no_ai_credential' }, 'lifecycle')
        void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'failed', fromState: 'claimed', toState: 'failed', metadata: { reason: 'no_ai_credential' } })
        emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_blocked', taskId: task.id, reason: 'No AI credential' })
        trackEvent('task.failed', 'warning', { taskId: task.id, reason: 'no_ai_credential', workspaceId: taskWorkspaceId })
        logger.warn({ taskId: task.id, workspaceId: taskWorkspaceId }, 'No credential — task failed (permanent)')
        await releaseSlot(task.id)
        return
    }

    // ── Pre-flight: workspace weekly ceiling ──────────────────────────────────
    // Check before claiming CPU/memory so we fail fast if already over budget.
    // Honors workspace `costCeilingMode`:
    //   - 'hard_block' (default for legacy api_cost_tracking gate) → fail task
    //   - 'soft_warn'                                              → log + continue
    //   - 'off'                                                    → skip entirely (trust provider caps)
    try {
        const iSettings = await getCachedIntelligenceSettings(taskWorkspaceId ?? '', async () => {
            const [row] = await db
                .select({ s: workspaces.intelligenceSettings })
                .from(workspaces)
                .where(eq(workspaces.id, taskWorkspaceId ?? ''))
                .limit(1)
            return (row?.s ?? {}) as IntelligenceSettings
        })
        const ceilingMode = iSettings.costCeilingMode ?? 'hard_block'

        if (ceilingMode !== 'off') {
            const [costRow] = await db
                .select({ costUsd: apiCostTracking.costUsd, ceilingUsd: apiCostTracking.ceilingUsd })
                .from(apiCostTracking)
                .where(and(
                    eq(apiCostTracking.workspaceId, taskWorkspaceId ?? ''),
                    eq(apiCostTracking.weekStart, sql`date_trunc('week', NOW())::date`),
                ))
                .limit(1)

            if (costRow && costRow.costUsd >= costRow.ceilingUsd) {
                if (ceilingMode === 'hard_block') {
                    const costMsg = `Workspace weekly cost ceiling reached: $${costRow.costUsd.toFixed(4)} / $${costRow.ceilingUsd.toFixed(2)}`
                    await failTask(task.id, costMsg)
                    await syncSprintTaskBlocked(task, costMsg)
                    emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_blocked', taskId: task.id, reason: 'WORKSPACE_COST_CEILING' })
                    trackEvent('task.failed', 'warning', { taskId: task.id, reason: 'cost_ceiling', costUsd: costRow.costUsd, ceilingUsd: costRow.ceilingUsd, workspaceId: taskWorkspaceId })
                    logger.warn({ taskId: task.id, costUsd: costRow.costUsd, ceilingUsd: costRow.ceilingUsd }, 'Workspace ceiling — task failed (permanent)')
                    await releaseSlot(task.id)
                    return
                }
                // soft_warn: log only
                logger.warn({ taskId: task.id, costUsd: costRow.costUsd, ceilingUsd: costRow.ceilingUsd, mode: ceilingMode }, 'Workspace ceiling exceeded — soft_warn, continuing')
            }
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
        db.select({ name: workspaces.name, settings: workspaces.settings, intelligenceSettings: workspaces.intelligenceSettings })
            .from(workspaces).where(eq(workspaces.id, taskWorkspaceId ?? '')).limit(1).then(r => r[0]),
        // Sprint goal — only if task has a projectId (checked below)
        (task.context as Record<string, unknown> | null)?.sprintId
            ? db.select({ request: sprints.request }).from(sprints)
                .where(eq(sprints.id, String((task.context as Record<string, unknown>).sprintId))).limit(1).then(r => r[0])
            : Promise.resolve(undefined),
    ])

    // Extract workspace settings once
    const wsSettings = (wsRow?.settings ?? {}) as Record<string, unknown>

    // Resolve budgets — check new Intelligence page settings first, then legacy aiProviders
    const wsAiProviders = wsSettings.aiProviders as Record<string, unknown> | undefined
    const wsDefaultCostCeiling = (wsSettings.costCeilingUsd != null ? Number(wsSettings.costCeilingUsd) || null : null)
        ?? (wsAiProviders?.defaultTaskCostCeiling ? Number(wsAiProviders.defaultTaskCostCeiling) || null : null)
    const wsDefaultTokenBudget = (wsSettings.tokenBudgetPerTask != null ? Number(wsSettings.tokenBudgetPerTask) || null : null)
        ?? (wsAiProviders?.defaultTokenBudget ? Number(wsAiProviders.defaultTokenBudget) || null : null)
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
    const primaryRepo = typeof wsSettings.primaryRepo === 'string' ? wsSettings.primaryRepo : undefined

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
                const { exec } = await import('node:child_process')
                const { promisify } = await import('node:util')
                const { mkdtempSync } = await import('node:fs')
                const { join } = await import('node:path')
                const { tmpdir } = await import('node:os')
                const execAsync = promisify(exec)

                // Resolve token from installed_connections or env
                const { resolveGitHubToken } = await import('@plexo/agent/github/client')
                const token = await resolveGitHubToken(ctxWorkspaceId).catch(() => process.env.GITHUB_TOKEN ?? '')

                const workDir = mkdtempSync(join(tmpdir(), 'plexo-sprint-'))
                const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`

                await execAsync(
                    `git clone --depth=1 --branch ${branch} ${cloneUrl} .`,
                    { cwd: workDir, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
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
    } catch (mkdirErr) {
        logger.warn({ err: mkdirErr, taskId: task.id, taskWorkDir }, 'Failed to create task workdir — falling back to process.cwd()')
    }

    // Per-task model override: task.context.modelOverrideId forces Mode 4 routing
    const taskContext0 = task.context as Record<string, unknown> | null | undefined
    const modelOverrideId = typeof taskContext0?.modelOverrideId === 'string' && taskContext0.modelOverrideId
        ? taskContext0.modelOverrideId
        : undefined

    const sprintId: string | undefined = taskRow?.projectId ?? undefined

    // ── Execution Priming: pre-load sprint-scoped files ──────────────────────────
    // For coding tasks with a cloned workdir, read the files declared in the sprint
    // task's scope[] so the executor starts with repo context already available.
    // Capped at 20 files × 100 KB each to stay within practical token budgets.
    let scopeFiles: Array<{ path: string; content: string }> | undefined
    if (sprintWorkDir && task.type === 'coding') {
        const taskCtx = task.context as Record<string, unknown> | null | undefined
        const rawScope = taskCtx?.scope
        const scopePaths: string[] = Array.isArray(rawScope)
            ? (rawScope as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 20)
            : []

        if (scopePaths.length > 0) {
            const { readFile } = (await import('node:fs')).promises
            const { resolve, isAbsolute } = await import('node:path')
            const MAX_BYTES = 100_000
            scopeFiles = []
            for (const p of scopePaths) {
                try {
                    const abs = isAbsolute(p) ? p : resolve(sprintWorkDir, p)
                    const content = await readFile(abs, 'utf8')
                    scopeFiles.push({ path: p, content: content.slice(0, MAX_BYTES) })
                } catch { /* non-fatal — skip unreadable file */ }
            }
            if (scopeFiles.length === 0) scopeFiles = undefined
        }
    }

    // Resolve Brave Search key for this workspace (DB key > env fallback)
    const braveSearchApiKey = taskWorkspaceId
        ? await getDecryptedBraveKey(taskWorkspaceId).catch(() => process.env.BRAVE_SEARCH_API_KEY ?? undefined)
        : process.env.BRAVE_SEARCH_API_KEY ?? undefined
    // Tavily API key (env only for now — add workspace storage alongside Brave later)
    const tavilyApiKey = process.env.TAVILY_API_KEY ?? undefined

    // Extract attached image URLs from the task context. Channels drop image
    // URLs into context.imageUrls when the originating message carried
    // pictures (Telegram photo, Slack file, Discord attachment, dashboard
    // chat upload). The executor uses these to build a multimodal first
    // user message and route to a vision-capable model.
    const inputImageUrls: string[] | undefined = (() => {
        const raw = (task.context as Record<string, unknown> | null | undefined)?.imageUrls
        if (!Array.isArray(raw)) return undefined
        const urls = raw.filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
        return urls.length > 0 ? urls : undefined
    })()

    const ctx: ExecutionContext = {
        taskId: task.id,
        workspaceId: taskWorkspaceId ?? '',
        userId: 'system',
        credential,
        taskType: task.type as import('@plexo/agent/types').TaskType ?? 'coding',
        tokenBudget: resolvedTokenBudget,
        taskCostCeilingUsd: resolvedCostCeiling,
        signal: abort.signal,
        inputImageUrls,
        // Phase A: workspace + persona context
        workspaceName,
        agentName,
        agentPersona,
        workspaceSummary,
        primaryRepo,
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
        scopeFiles,
        // Web-search keys — workspace-scoped, resolved here so agent package stays secret-free
        braveSearchApiKey: braveSearchApiKey ?? undefined,
        tavilyApiKey,
        // Live event streaming to SSE clients — enabled for all tasks (Phase 2)
        emitStepEvent: (event) => emitToWorkspace(taskWorkspaceId ?? '', event as unknown as import('./sse-emitter.js').AgentEvent),
        // FUN-014: checkpoint resume from a prior task's steps
        resumeFromTaskId: (task.context as Record<string, unknown> | null)?.resumeFromTaskId as string | undefined,
    }

    // SCL: expand Golden Record into task context
    let sclAttractorIds: string[] = []
    try {
        if (taskWorkspaceId) {
            const { expandForTask } = await import('@plexo/agent/scl/task-expansion')
            const { resolveEmbeddingProvider } = await import('@plexo/agent/scl/embedding-provider')
            {
                const embProvider = await resolveEmbeddingProvider(taskWorkspaceId)
                const taskCtxRaw = (task.context as Record<string, unknown>) ?? {}
                const desc = String(taskCtxRaw.description ?? taskCtxRaw.message ?? task.type ?? '')
                const focusLevel = (taskCtxRaw.focusLevel as string) ?? 'L1'
                const level = (['L0', 'L1', 'L2'].includes(focusLevel) ? focusLevel : 'L1') as import('@plexo/scl-core').ResolutionLevel
                const expansion = await expandForTask(taskWorkspaceId, desc, embProvider, level)
                if (expansion) {
                    ctx.sclContext = {
                        relevantPatterns: [],
                        suggestedTools: [],
                        domainKnowledge: [expansion.contextBlock],
                        tokenCount: expansion.tokenCount,
                        sourceRegions: expansion.regionsActivated,
                    }
                    sclAttractorIds = expansion.attractorIds
                    logger.info({ taskId: task.id, regions: expansion.regionsActivated, tokens: expansion.tokenCount, attractors: expansion.attractorsExpanded }, 'SCL Golden Record context expanded')
                }
            }
        }
    } catch (err) {
        logger.warn({ err, taskId: task.id }, 'SCL expansion failed — continuing without')
    }

    try {
        await db.update(tasks)
            .set({ status: 'running', claimedAt: new Date() })
            .where(eq(tasks.id, task.id))
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'claimed', to: 'running', workspaceId: taskWorkspaceId }, 'lifecycle')
        void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'claimed', fromState: 'claimed', toState: 'running' })

        const taskContext = task.context as Record<string, unknown>
        const description = (taskContext.description as string)
            ?? (taskContext.message as string)
            ?? JSON.stringify(taskContext)

        // Fast-path: skip the planner LLM call for simple tasks (< 120 chars, no special context).
        // The planner adds 5-15 seconds of latency for a second LLM round-trip that produces
        // a trivial 1-step plan for simple requests. Only run the full planner for complex tasks.
        // Threshold lowered from 200→120 so multi-deliverable requests ("HTML + marketing plan")
        // go through the planner where Hub discovery and capability checking happen.
        const isSimpleTask = description.length < 120
            && !taskContext.repo
            && !taskContext.sprintTaskId
            && !description.toLowerCase().includes('project')
            && !description.toLowerCase().includes('migration')
            && !description.toLowerCase().includes('deploy')
            && !description.toLowerCase().includes('build')
            && !description.toLowerCase().includes('create')
            && !description.toLowerCase().includes('audit')
            && !description.toLowerCase().includes('review')

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
            void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'planning', fromState: 'running', toState: 'planning' })
            plannerResult = await planTask(ctx, description, taskContext, aiSettings ?? undefined)
        }

        // Phase D: capability pre-flight — planner returned a clarification request
        if (plannerResult.type === 'clarification') {
            logger.info({ taskId: task.id, alternatives: plannerResult.alternatives.length }, 'Planner returned clarification — capability gap detected')
            logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'planning', to: 'blocked', workspaceId: taskWorkspaceId, reason: 'clarification_needed' }, 'lifecycle')
            void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'blocked', fromState: 'planning', toState: 'blocked', metadata: { reason: 'clarification_needed', alternatives: plannerResult.alternatives.length } })
            trackEvent('task.blocked', 'info', { taskId: task.id, reason: 'clarification_needed', alternatives: plannerResult.alternatives.length, workspaceId: taskWorkspaceId })
            await blockTask(task.id, plannerResult.message)
            await syncSprintTaskBlocked(task, plannerResult.message)
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
        void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'executing', fromState: 'planning', toState: 'executing', metadata: { steps: plan.steps.length } })
        emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_planned', taskId: task.id, steps: plan.steps.length, confidence: plan.confidenceScore })

        if (plan.oneWayDoors.length > 0) {
            logger.warn({ taskId: task.id, doors: plan.oneWayDoors.length }, 'One-way doors detected — auto-approving in Phase 2')
        }

        // Pass workspace AI settings so executeTask uses the configured provider fallback chain
        const result = await executeTask(ctx, plan, aiSettings ?? undefined)
        logger.info({ taskId: task.id, ok: result.ok, cost: result.totalCostUsd }, 'Task executed')

        // Analytics: inference gateway call
        try {
            const { emitInferenceInvoked } = await import('./analytics/events.js')
            emitInferenceInvoked({
                modelFamily: ctx.activeProvider ?? 'unknown',
                latencyMs: Date.now() - taskStartMs,
                success: result.ok,
            })
        } catch { /* analytics must never crash the app */ }

        // SCL: log inference + extract structural graph (fire-and-forget)
        let inferenceLogId: string | undefined
        try {
            const { classifyDomainRegion } = await import('@plexo/agent/scl/classifier')
            const taskCtx = (task.context as Record<string, unknown>) ?? {}
            const taskDesc = String(taskCtx.instructions ?? taskCtx.goal ?? task.type ?? '')
            const region = classifyDomainRegion(taskDesc, task.type ?? undefined)
            const rows = await db.execute<{ id: string }>(sql`
                INSERT INTO inference_logs (instance_uuid, model, provider, input_tokens, output_tokens, latency_ms, domain_region, task_type, success)
                VALUES (${process.env.PLEXO_INSTANCE_ID ?? 'unknown'}, ${ctx.activeModel ?? 'unknown'}, ${ctx.activeProvider ?? 'unknown'},
                        ${result.totalTokensIn}, ${result.totalTokensOut}, ${result.totalDurationMs},
                        ${region}, ${task.type ?? 'unknown'}, ${result.ok})
                RETURNING id
            `)
            inferenceLogId = rows[0]?.id

            // SCL-S structural extraction
            const { extractAndStoreSclS } = await import('@plexo/agent/scl/extractor')
            const toolsUsed = [...new Set(result.steps.flatMap(s => s.toolCalls.map(tc => tc.tool)))]
            void extractAndStoreSclS({
                taskId: task.id,
                workspaceId: taskWorkspaceId ?? '',
                type: task.type ?? 'unknown',
                domainRegion: region,
                toolsUsed,
                stepCount: result.steps.length,
                qualityScore: result.qualityScore,
                completedAt: new Date(),
                inferenceLogId,
            })

            // Mindset recompression: every 50 tasks per workspace
            if (taskWorkspaceId) {
                const [countRow] = await db.execute<{ count: number }>(sql`
                    SELECT count(*) as count FROM scl_concept_graphs WHERE workspace_id = ${taskWorkspaceId}::uuid
                `)
                const graphCount = Number(countRow?.count ?? 0)
                if (graphCount > 0 && graphCount % 50 === 0) {
                    const { compressToMindsetObject } = await import('@plexo/agent/scl/compressor')
                    const graphRows = await db.execute<{ graph_json: unknown }>(sql`
                        SELECT graph_json FROM scl_concept_graphs
                        WHERE workspace_id = ${taskWorkspaceId}::uuid AND graph_json IS NOT NULL
                        ORDER BY created_at DESC LIMIT 200
                    `)
                    const graphs = graphRows.map((r: any) => r.graph_json).filter(Boolean)
                    const mindset = compressToMindsetObject(graphs, taskWorkspaceId)
                    await db.execute(sql`
                        INSERT INTO workspace_mindsets (workspace_id, mindset_object, task_count, version)
                        VALUES (${taskWorkspaceId}::uuid, ${JSON.stringify(mindset)}::jsonb, ${graphCount}, 1)
                        ON CONFLICT (workspace_id) DO UPDATE SET
                            mindset_object = EXCLUDED.mindset_object,
                            task_count = EXCLUDED.task_count,
                            version = workspace_mindsets.version + 1,
                            updated_at = NOW()
                    `)
                    logger.info({ workspaceId: taskWorkspaceId, graphCount }, 'Workspace mindset recompressed')
                }
            }
        } catch (sclErr) {
            logger.warn({ err: sclErr, taskId: task.id }, 'SCL post-task processing failed (non-fatal)')
        }

        await completeTask(task.id, {
            qualityScore: result.qualityScore,
            outcomeSummary: result.outcomeSummary,
            tokensIn: result.totalTokensIn,
            tokensOut: result.totalTokensOut,
            costUsd: result.totalCostUsd,
        })
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'running', to: 'complete', workspaceId: taskWorkspaceId, durationMs: Date.now() - taskStartMs, costUsd: result.totalCostUsd }, 'lifecycle')
        void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'complete', fromState: 'running', toState: 'complete', metadata: { durationMs: Date.now() - taskStartMs, costUsd: result.totalCostUsd } })

        // Analytics: if this is the workspace's first completed task, emit onboarding_completed
        try {
            const { emitOnboardingCompleted } = await import('./analytics/events.js')
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
        } catch { /* analytics must never crash the app */ }

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

        // SEC-034: Atomic Redis spend counter for cross-process cost ceiling consistency
        if (result.totalCostUsd > 0 && taskWorkspaceId) {
            try {
                const { recordSpend } = await import('@plexo/agent/cost-gate')
                void recordSpend(taskWorkspaceId, result.totalCostUsd)
            } catch (costErr) {
                logger.warn({ err: costErr, workspaceId: taskWorkspaceId }, 'Failed to record spend in Redis (will recompute from DB)')
            }
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

        // ── Post-task reflection (non-fatal) ──────────────────────────────────
        // When scl_enabled=true, this drives Golden Record mutation (structured
        // concepts + relations). Otherwise it is gated by workspace preference
        // `reflection_enabled` and produces text-based behavior rules.
        try {
            const taskCtxForReflect = task.context as Record<string, unknown> | null | undefined
            const goal = (taskCtxForReflect?.description as string)
                ?? (taskCtxForReflect?.message as string)
                ?? task.type
            const reflectToolsUsed = [...new Set(
                (result.steps ?? []).flatMap(s => (s.toolCalls ?? []).map(tc => tc.tool))
            )]
            const reflectResult = await reflectAndPromote({
                workspaceId: taskWorkspaceId ?? '',
                taskId: task.id,
                goal,
                taskType: task.type,
                toolsUsed: reflectToolsUsed,
                qualityScore: result.qualityScore,
                outcomeSummary: result.outcomeSummary ?? '',
                stepCount: result.steps?.length ?? 0,
                durationMs: Date.now() - taskStartMs,
            })
            // ── Wire analytics emitters (domain mastery Phase 1) ──────────
            if (reflectResult.track !== 'skipped') {
                emitReflectionEvent({
                    track: reflectResult.track === 'scl' ? 'success' : reflectResult.track,
                    observationCount: reflectResult.observationCount,
                    taskType: task.type,
                })
            }
            if (reflectResult.track === 'scl' && reflectResult.sclStats) {
                emitSclMutate({
                    attractorsRefined: reflectResult.sclStats.attractorsRefined,
                    attractorsCreated: reflectResult.sclStats.attractorsCreated,
                    ghostsArchived: reflectResult.sclStats.ghostsArchived,
                    driftWarnings: reflectResult.sclStats.driftWarnings,
                })
                // Emit individual drift warnings
                if (reflectResult.sclStats.driftWarnings > 0) {
                    emitSclDriftWarning({
                        attractorLabel: 'aggregate',
                        semanticDistance: 0,
                        threshold: 0,
                    })
                }
            }
        } catch (reflectErr) {
            logger.warn({ err: reflectErr, taskId: task.id }, 'reflectAndPromote failed — non-fatal')
        }

        // ── SCL experience loop: update attractor salience from task outcome ──
        if (sclAttractorIds.length > 0 && taskWorkspaceId) {
            try {
                const { updateSalience } = await import('@plexo/agent/scl/task-expansion')
                const accepted = result.qualityScore >= 0.7
                void updateSalience(taskWorkspaceId, sclAttractorIds, accepted)
                    .catch((e: unknown) => logger.warn({ err: e }, 'SCL salience update failed'))
            } catch (sclImportErr) {
                logger.debug({ err: sclImportErr }, 'SCL salience import failed (non-fatal)')
            }
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
        const { readdir } = (await import('node:fs')).promises
        const assets: string[] = await readdir(`/tmp/plexo-assets/${task.id}`).catch(() => [])

        emitToWorkspace(taskWorkspaceId ?? '', {
            type: 'task_complete',
            taskId: task.id,
            qualityScore: result.qualityScore,
            costUsd: result.totalCostUsd,
            // Use non-empty summary: executor early-exit paths (cost gate, OWD) return outcomeSummary: ''
            // which would cause channel adapters to silently drop the message. Fall back to error text.
            summary: result.outcomeSummary?.trim() || result.error?.trim() || 'Task completed.',
            assets,
        })

        _progressStopper.stop?.()
        _progressStopper.stop = null

        // Persistent channel delivery — delivers results to originating channel (Telegram, etc.)
        // This is the DB-backed delivery path that survives process restarts.
        const originCtx = (task.context as Record<string, unknown>) ?? {}
        if (originCtx.channel && originCtx.chatId) {
            const { deliverToOriginChannel } = await import('./channel-delivery.js')
            void deliverToOriginChannel({
                taskId: task.id,
                workspaceId: taskWorkspaceId ?? '',
                context: { ...originCtx, channel: originCtx.channel as string, chatId: originCtx.chatId as string | number, description: originCtx.description as string | undefined },
                summary: result.outcomeSummary?.trim() || result.error?.trim() || 'Task completed.',
                assets,
                outcome: 'complete',
            }).catch(err => logger.warn({ err, taskId: task.id }, 'Channel delivery failed'))
        }
        trackEvent('task.complete', 'info', {
            taskId: task.id,
            type: task.type,
            source: task.source,
            durationMs: Date.now() - taskStartMs,
            costUsd: result.totalCostUsd,
            qualityScore: result.qualityScore,
        })

        // ── Low quality task emission ─────────────────────────────────────
        if (result.qualityScore != null && result.qualityScore < 0.5) {
            try {
                trackError(new Error(`Low quality task: score=${result.qualityScore}`), {
                    workspaceId: taskWorkspaceId,
                    taskId: task.id,
                    category: 'task_quality',
                    qualityScore: result.qualityScore,
                })
            } catch { /* non-fatal */ }
        }

        // ── Backfill conversation record with the agent reply ─────────────
        // Any source (dashboard, telegram, slack, etc.) can create a
        // conversations row at queue time with status='pending' and no reply.
        // Now that the task is done, update that row so the Conversations
        // page shows the agent response.
        if (result.outcomeSummary) {
            try {
                const { updateConversationForTask } = await import('./conversation-log.js')
                await updateConversationForTask(task.id, {
                    reply: result.outcomeSummary,
                    status: 'complete',
                })
            } catch (convErr) {
                logger.warn({ err: convErr, taskId: task.id }, 'Failed to backfill conversation reply — non-fatal')
            }
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Surface a structured error code (when the thrower attached one)
        // into the lifecycle log + the task's blockTask reason so the
        // task UI can show "[CODE] message" instead of a bare message.
        const errCode = (err as { code?: string; errorCode?: string } | null)?.code
            ?? (err as { code?: string; errorCode?: string } | null)?.errorCode
            ?? null
        const reasonPrefix = errCode && errCode !== 'EXECUTOR_ERROR' ? `[${errCode}] ` : ''
        logger.error({ taskId: task.id, err, code: errCode }, 'Task failed')
        _progressStopper.stop?.()
        _progressStopper.stop = null

        // FUN-037: Auto-retry transient errors (timeout, rate limit, network)
        // instead of immediately blocking and alarming the user.
        const TRANSIENT_PATTERNS = [
            /timeout/i, /ETIMEDOUT/i, /ECONNRESET/i, /ECONNREFUSED/i,
            /rate.?limit/i, /429/i, /503/i, /502/i, /overloaded/i,
            /AbortError/i, /network/i, /socket hang up/i,
        ]
        const isTransient = TRANSIENT_PATTERNS.some(p => p.test(message))
            || errCode === 'CALL_MODEL_TIMEOUT'
            || errCode === 'CALL_MODEL_RATE_LIMIT'
            || errCode === 'CALL_MODEL_OVERLOADED'

        if (isTransient) {
            const retryResult = await requeueForRetry(task.id, { maxAttempts: 3, backoffBase: 60 })
            logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'running', to: retryResult === 'requeued' ? 'queued' : 'failed', workspaceId: taskWorkspaceId, durationMs: Date.now() - taskStartMs, error: message.slice(0, 200), code: errCode, retryResult }, 'lifecycle')
            void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: retryResult === 'requeued' ? 'requeued' : 'failed', fromState: 'running', toState: retryResult === 'requeued' ? 'queued' : 'failed', metadata: { durationMs: Date.now() - taskStartMs, error: message.slice(0, 200), code: errCode, retryResult } })
            trackEvent('task.retried', 'info', { taskId: task.id, error: message, code: errCode ?? undefined, workspaceId: taskWorkspaceId, retryResult })
            if (retryResult === 'max_attempts') {
                await syncSprintTaskBlocked(task, `Failed after retries: ${reasonPrefix}${message}`)
            }
        } else {
            logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'running', to: 'blocked', workspaceId: taskWorkspaceId, durationMs: Date.now() - taskStartMs, error: message.slice(0, 200), code: errCode }, 'lifecycle')
            void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'blocked', fromState: 'running', toState: 'blocked', metadata: { durationMs: Date.now() - taskStartMs, error: message.slice(0, 200), code: errCode } })
            trackEvent('task.failed', 'error', { taskId: task.id, error: message, code: errCode ?? undefined, workspaceId: taskWorkspaceId })
            await blockTask(task.id, reasonPrefix + message)
            await syncSprintTaskBlocked(task, reasonPrefix + message)
        }
        try {
            trackError(new Error(`Task failed: ${reasonPrefix}${message}`), {
                workspaceId: taskWorkspaceId,
                taskId: task.id,
                category: 'task_outcome',
                errorCode: reasonPrefix,
            })
        } catch { /* non-fatal */ }

        // Persistent channel delivery for failures
        const failContext = (task.context as Record<string, unknown>) ?? {}
        if (failContext.channel && failContext.chatId) {
            const { deliverToOriginChannel } = await import('./channel-delivery.js')
            void deliverToOriginChannel({
                taskId: task.id,
                workspaceId: taskWorkspaceId ?? '',
                context: { ...failContext, channel: failContext.channel as string, chatId: failContext.chatId as string | number, description: failContext.description as string | undefined },
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

        // ── Backfill conversation record on failure ───────────────────────
        try {
            const { updateConversationForTask } = await import('./conversation-log.js')
            await updateConversationForTask(task.id, {
                errorMsg: message.slice(0, 2000),
                status: 'failed',
            })
        } catch (convErr) {
            logger.warn({ err: convErr, taskId: task.id }, 'Failed to backfill conversation error — non-fatal')
        }

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
        trackEvent('task.failed', 'error', {
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

/** Cancel stale blocked tasks older than 2 hours so they don't pile up.
 *  Queued tasks get a longer window (7 days) since they may be legitimately waiting.
 *  Claim-timeout fix: requeue any task whose claimed_until has elapsed —
 *  covers both 'claimed' (worker died before transitioning to 'running') and
 *  'running' (heartbeat refresh failed) states. The column is written by
 *  queue.claim() and indexed by tasks_claimed_until_idx. */
async function cleanupStaleTasks(): Promise<void> {
    try {
        // 1. Find tasks whose claim has expired in either claimed or running state.
        const expired = await db.execute<{ id: string; workspace_id: string; status: string }>(sql`
            SELECT id, workspace_id, status FROM tasks
            WHERE status IN ('claimed', 'running')
              AND claimed_until IS NOT NULL
              AND claimed_until < NOW()
            LIMIT 50
        `)
        if (expired.length > 0) {
            for (const row of expired) {
                const retryResult = await requeueForRetry(row.id, { maxAttempts: 3, backoffBase: 120 })
                const toState = retryResult === 'requeued' ? 'queued' : 'failed'
                logger.info({ event: 'task.lifecycle', taskId: row.id, from: row.status, to: toState, workspaceId: row.workspace_id, reason: 'claim_timeout', retryResult }, 'lifecycle')
                void recordTaskEvent({ workspaceId: row.workspace_id, taskId: row.id, eventType: 'claim_timeout', fromState: row.status, toState, metadata: { reason: 'claim_timeout', retryResult } })
            }
        }

        const result = await db.execute<typeof tasks.$inferSelect>(sql`
            UPDATE tasks
            SET status = 'cancelled',
                outcome_summary = COALESCE(outcome_summary, 'Auto-resolved: stale task cleaned up')
            WHERE (status = 'blocked' AND created_at < NOW() - INTERVAL '2 hours')
               OR (status = 'queued' AND created_at < NOW() - INTERVAL '7 days')
            RETURNING *
        `)
        const cancelled = Array.isArray(result) ? result : []
        if (cancelled.length > 0) {
            logger.info({ count: cancelled.length }, 'Cleaned up stale blocked/queued tasks')
            // DI-006: Batch-sync sprint_tasks for cancelled stale tasks
            const sprintIds = cancelled
                .map(t => (t.context as Record<string, unknown> | null)?.sprintTaskId as string | undefined)
                .filter((id): id is string => !!id)
            if (sprintIds.length > 0) {
                await db.update(sprintTasks)
                    .set({
                        status: 'failed',
                        handoff: sql`COALESCE(handoff, '{}'::jsonb) || ${JSON.stringify({ outcome: 'Auto-cancelled: stale after 7 days' })}::jsonb`,
                    })
                    .where(inArray(sprintTasks.id, sprintIds))
                logger.info({ count: sprintIds.length }, 'Sprint tasks status synced in batch')
            }
        }
    } catch (err) {
        logger.warn({ err }, 'Stale task cleanup failed — non-fatal')
    }
}

// Belt-and-suspenders backstop for cleanupStaleTasks — covers any running task whose claimed_until somehow wasn't set or wasn't picked up by the primary sweep.
async function recoverGhostTasks(): Promise<void> {
    try {
        const ghosts = await db.execute<{ id: string; workspace_id: string }>(sql`
            SELECT id, workspace_id FROM tasks
            WHERE status = 'running'
              AND claimed_at < NOW() - INTERVAL '3 minutes'
            LIMIT 20
        `)
        const untracked = ghosts.filter(g => !activeTasks.has(g.id))
        if (untracked.length === 0) return

        // Batch-clear claimed_at in one round-trip before individual requeues
        const ids = untracked.map(g => g.id)
        await db.update(tasks)
            .set({ claimedAt: null })
            .where(and(inArray(tasks.id, ids), sql`${tasks.status} = 'running'`))
        for (const ghost of untracked) {
            const outcome = await requeueForRetry(ghost.id, { maxAttempts: 3, backoffBase: 120 })
            const toState = outcome === 'requeued' ? 'queued' : 'failed'
            logger.info({ event: 'task.lifecycle', taskId: ghost.id, outcome, reason: 'ghost_recovery' }, 'lifecycle')
            void recordTaskEvent({ workspaceId: ghost.workspace_id, taskId: ghost.id, eventType: 'ghost_recovery', fromState: 'running', toState, metadata: { reason: 'ghost_recovery', outcome } })
        }
    } catch (err) {
        logger.warn({ err }, 'Ghost task recovery failed — non-fatal')
    }
}

export function startAgentLoop(): void {
    logger.info('Agent queue loop started')

    // Clean up stale blocked tasks at startup + every 30 minutes
    void cleanupStaleTasks()
    setInterval(() => { void cleanupStaleTasks() }, 30 * 60 * 1000)

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
