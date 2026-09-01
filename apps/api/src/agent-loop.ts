// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { claimTask, completeTask, blockTask, requeueForRetry } from '@plexo/queue'
import { eq, and, sql, inArray } from 'drizzle-orm'
import { db } from '@plexo/db'
import { tasks, apiCostTracking, workspaces, sprints, sprintTasks, plexoOpsTaskEvents } from '@plexo/db'
import { planTask } from '@plexo/agent/planner'
import type { ExecutionPlan } from '@plexo/agent/types'
import { executeTask } from '@plexo/agent/executor'
import { markTaskFailed } from '@plexo/agent/tasks/terminal-fail'
import { FailureReason, type TaskCompletedPayload, type EscalationSummary } from '@plexo/agent/tasks/types'
import { classifyCapabilityGap } from '@plexo/agent/tasks/classify-capability-gap'
import { eventBus, TOPICS } from '@plexo/agent/event-bus'
import { reflectAndPromote } from '@plexo/agent/behavior/reflect'
import { storeMemory } from '@plexo/agent/memory/store'
import { toMicro, cmpMicro, fmtMicroUsd, microToNumber } from '@plexo/agent/money'
import type { AnthropicCredential, ExecutionContext } from '@plexo/agent/types'
import { emitToWorkspace } from './sse-emitter.js'
import { channelSupportsConfirmation } from './channel-state-format.js'
import { registerCodeContext, unregisterCodeContext } from './routes/code.js'
import { emitTaskOutcome, emitReflectionEvent } from './analytics/events.js'
import { trackError, trackEvent } from './event-tracker.js'
import type { WorkspaceAISettings, ProviderKey, AIProviderConfig } from '@plexo/agent/providers/registry'
import { logger } from './logger.js'

import { loadDecryptedAIProviders } from './routes/ai-provider-creds.js'
import { getDecryptedBraveKey } from './routes/search.js'
import { claimBatch, releaseSlot, extendSlot, HEARTBEAT_INTERVAL_MS } from './parallel-executor.js'
import { requestApproval, waitForDecision, getDecision, elevateOutboundOneWayDoors, type PendingDecision } from '@plexo/agent/one-way-door'
import { getCachedIntelligenceSettings, type IntelligenceSettings } from './lib/intelligence-cache.js'
import { incrementCounter } from './lib/metrics.js'
import { createHash } from 'node:crypto'

const POLL_INTERVAL_MS = 2_000
const API_COST_CEILING = parseFloat(process.env.API_COST_CEILING_USD ?? '50')

// Worker-slot release during awaiting_approval. Default off — long approval waits
// continue to pin the worker (today's behavior). When set to 'planner_only', the
// planner-gate path persists `_resumeAt='after_planner_gate'` on tasks.context,
// returns from the executor (slot/heartbeat/activeTasks released by the existing
// finally), and the OWD_RESOLVED bus subscriber CAS-resumes via status →
// 'queued'. The resumed claim re-enters buildTaskContext, sees `_resumeAt`, and
// jumps straight to executeTask using the persisted `tasks.plan`. The
// in-executor OWD gate (executor/index.ts) is NOT covered by this — it sits
// inside live tool/MCP sessions and needs a separate design.
const OWD_RELEASE_SLOT = process.env.OWD_RELEASE_SLOT === 'planner_only'

let running = true
let activeTasks: Map<string, AbortController> = new Map()
let sessionCount = 0
let lastActivity: string | null = null

// Canonical event_type values written to plexo_ops_task_events:
//   claimed, planning, plan_proposed, executing, complete, failed, blocked,
//   requeued, claim_timeout, ghost_recovery, manual_requeue, manual_cancel,
//   awaiting_approval, approval_granted, approval_rejected, approval_timeout,
//   resumed.
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
 * Phase F1: emit the plan_proposal SSE event + plan_proposed lifecycle row.
 * Gated to plans with at least three steps so trivial / fast-path single-step
 * plans don't render an inline plan card. Returns true when the gate fires
 * (event emitted), false when skipped.
 *
 * Exported for integration tests; production callers go through processTask.
 */
export function emitPlanProposal(params: {
    workspaceId: string
    taskId: string
    plan: ExecutionPlan
    requiresApproval: boolean
    approvalId: string | null
}): boolean {
    if (params.plan.steps.length < 3) return false
    logger.info({
        event: 'plan_proposed',
        taskId: params.taskId,
        workspaceId: params.workspaceId,
        stepCount: params.plan.steps.length,
        requiresApproval: params.requiresApproval,
        approvalId: params.approvalId,
        confidence: params.plan.confidenceScore,
    }, 'plan_proposed')
    emitToWorkspace(params.workspaceId, {
        type: 'plan_proposal',
        taskId: params.taskId,
        plan: {
            goal: params.plan.goal,
            steps: params.plan.steps,
            oneWayDoors: params.plan.oneWayDoors ?? [],
            estimatedDurationMs: params.plan.estimatedDurationMs,
            confidenceScore: params.plan.confidenceScore,
            risks: params.plan.risks ?? [],
        },
        requiresApproval: params.requiresApproval,
        approvalId: params.approvalId,
    })
    void recordTaskEvent({
        workspaceId: params.workspaceId,
        taskId: params.taskId,
        eventType: 'plan_proposed',
        fromState: 'planning',
        toState: 'planning',
        metadata: {
            steps: params.plan.steps.length,
            confidence: params.plan.confidenceScore,
            requiresApproval: params.requiresApproval,
            approvalId: params.approvalId,
            oneWayDoors: (params.plan.oneWayDoors ?? []).length,
        },
    })
    return true
}

export interface WorkspaceApprovalPolicy {
    requireApprovalForGeneralTasks: boolean
}

export async function loadWorkspaceApprovalPolicy(workspaceId: string | undefined | null): Promise<WorkspaceApprovalPolicy> {
    if (!workspaceId) return { requireApprovalForGeneralTasks: false }
    try {
        const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        const s = ws?.settings as Record<string, unknown> | undefined
        return {
            requireApprovalForGeneralTasks: s?.requireApprovalForGeneralTasks === true,
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'failed to load workspace approval policy; defaulting to off')
        return { requireApprovalForGeneralTasks: false }
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

// Exported for integration testing only.
export { buildTaskContext as processTaskForTesting }

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
        const noCredCtx = (task.context as Record<string, unknown>) ?? {}
        const noCredDesc = (noCredCtx.description as string) ?? (noCredCtx.message as string) ?? task.type ?? 'task'
        // No aiSettings passed — escalation falls back to deterministic (can't call LLM with no credential).
        const noCredFail = await markTaskFailed({
            taskId: task.id,
            workspaceId: taskWorkspaceId ?? '',
            failureReason: FailureReason.ToolError,
            errorText: 'No AI credential configured for workspace',
            taskDescription: noCredDesc,
        })
        await syncSprintTaskBlocked(task, 'No AI credential configured for workspace')
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'claimed', to: 'failed', workspaceId: taskWorkspaceId, reason: 'no_ai_credential' }, 'lifecycle')
        void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'failed', fromState: 'claimed', toState: 'failed', metadata: { reason: 'no_ai_credential' } })
        emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_blocked', taskId: task.id, reason: 'No AI credential', summary: noCredFail.summary })
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
                .select({
                    costUsd: apiCostTracking.costUsd,
                    ceilingUsd: apiCostTracking.ceilingUsd,
                    costUsdNumeric: apiCostTracking.costUsdNumeric,
                    ceilingUsdNumeric: apiCostTracking.ceilingUsdNumeric,
                })
                .from(apiCostTracking)
                .where(and(
                    eq(apiCostTracking.workspaceId, taskWorkspaceId ?? ''),
                    eq(apiCostTracking.weekStart, sql`date_trunc('week', NOW())::date`),
                ))
                .limit(1)

            // A6 cutover: decimal-safe compare via numeric column when present.
            // Falls back to the real columns if a row predates the expand backfill.
            const costMicro = toMicro(costRow?.costUsdNumeric ?? costRow?.costUsd ?? null)
            const ceilMicro = toMicro(costRow?.ceilingUsdNumeric ?? costRow?.ceilingUsd ?? null)
            if (costRow && cmpMicro(costMicro, ceilMicro) >= 0) {
                if (ceilingMode === 'hard_block') {
                    const costMsg = `Workspace weekly cost ceiling reached: $${fmtMicroUsd(costMicro, 4)} / $${fmtMicroUsd(ceilMicro, 2)}`
                    const costCtx = (task.context as Record<string, unknown>) ?? {}
                    const costDesc = (costCtx.description as string) ?? (costCtx.message as string) ?? task.type ?? 'task'
                    const costFail = await markTaskFailed({
                        taskId: task.id,
                        workspaceId: taskWorkspaceId ?? '',
                        failureReason: FailureReason.CostCeilingExceeded,
                        errorText: costMsg,
                        taskDescription: costDesc,
                        aiSettings: aiSettings ?? undefined,
                    })
                    await syncSprintTaskBlocked(task, costMsg)
                    emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_blocked', taskId: task.id, reason: 'WORKSPACE_COST_CEILING', summary: costFail.summary })
                    trackEvent('task.failed', 'warning', { taskId: task.id, reason: 'cost_ceiling', costUsd: microToNumber(costMicro), ceilingUsd: microToNumber(ceilMicro), workspaceId: taskWorkspaceId })
                    logger.warn({ taskId: task.id, costUsd: microToNumber(costMicro), ceilingUsd: microToNumber(ceilMicro) }, 'Workspace ceiling — task failed (permanent)')
                    await releaseSlot(task.id)
                    return
                }
                // soft_warn: log only
                logger.warn({ taskId: task.id, costUsd: microToNumber(costMicro), ceilingUsd: microToNumber(ceilMicro), mode: ceilingMode }, 'Workspace ceiling exceeded — soft_warn, continuing')
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
        // B17 weak/strong split — only ever true when the workspace explicitly
        // set it, so an untouched workspace keeps routing sub-agents strong.
        if (wsSettings.weakDelegateModel === true) aiSettings.weakDelegateModel = true
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

    // ── Sprint/routine repo context: clone repo to temp dir ─────────────────────
    // Coding tasks: { repo, branch } set by sprint runner.
    // Cron-triggered tasks: { repoUrl, branchRef } set by cron-dispatch bridge.
    {
        const taskCtx = task.context as Record<string, unknown> | null | undefined
        const repo = (taskCtx?.repo ?? taskCtx?.repoUrl) as string | undefined
        const branch = (taskCtx?.branch ?? taskCtx?.branchRef) as string | undefined
        const ctxWorkspaceId = (taskCtx?.workspaceId as string | undefined) ?? taskWorkspaceId

        if (repo && branch) {
            try {
                const { exec } = await import('node:child_process')
                const { promisify } = await import('node:util')
                const { mkdtempSync } = await import('node:fs')
                const { join } = await import('node:path')
                const { tmpdir } = await import('node:os')
                const execAsync = promisify(exec)

                // Resolve SSH deploy key from installed_connections (registryId: 'github_deploy_key')
                const { installedConnections } = await import('@plexo/db')
                const { eq, and } = await import('drizzle-orm')
                const { decrypt } = await import('@plexo/agent/connections/crypto-util')

                const [deployKeyRow] = await db
                    .select({ credentials: installedConnections.credentials })
                    .from(installedConnections)
                    .where(and(
                        eq(installedConnections.workspaceId, ctxWorkspaceId),
                        eq(installedConnections.registryId, 'github_deploy_key'),
                        eq(installedConnections.status, 'active'),
                    ))
                    .limit(1)

                if (!deployKeyRow?.credentials) {
                    throw new Error('Configure GitHub deploy key in Settings → Connections')
                }

                const rawCreds = deployKeyRow.credentials as { encrypted?: string }
                if (!rawCreds.encrypted) {
                    throw new Error('Configure GitHub deploy key in Settings → Connections')
                }

                const decrypted = decrypt(rawCreds.encrypted, ctxWorkspaceId)
                const creds = JSON.parse(decrypted) as Record<string, string>
                const privateKey = creds.private_key ?? creds.key ?? Object.values(creds).find(Boolean)
                if (!privateKey) {
                    throw new Error('Configure GitHub deploy key in Settings → Connections')
                }

                const workDir = mkdtempSync(join(tmpdir(), 'plexo-sprint-'))
                const sshUrl = `git@github.com:${repo}.git`

                // Write private key to temp file and use GIT_SSH_COMMAND to specify identity
                const { writeFileSync, chmodSync } = await import('node:fs')
                const keyPath = join(workDir, 'deploy_key')
                writeFileSync(keyPath, privateKey, { mode: 0o600 })
                chmodSync(keyPath, 0o600)

                const gitSshCommand = `ssh -i ${keyPath} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`

                await execAsync(
                    `git clone --depth=1 --branch ${branch} ${sshUrl} .`,
                    {
                        cwd: workDir,
                        timeout: 120_000,
                        maxBuffer: 64 * 1024 * 1024,
                        env: { ...process.env, GIT_SSH_COMMAND: gitSshCommand },
                    },
                )
                logger.info({ taskId: task.id, repo, branch, workDir }, 'Sprint repo cloned via SSH')

                sprintWorkDir = workDir
                sprintRepo = repo
                sprintBranch = branch
                // Register for Code Mode file tree + SSE
                registerCodeContext(task.id, taskWorkspaceId ?? '', workDir)
            } catch (cloneErr) {
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
        // Connector allowlist: restrict MCP tools to listed installed_connections.id values.
        // Fail-closed: automated sources (cron, github) default to [] (deny-all) when no
        // connector scope is configured. Interactive tasks remain allow-all (undefined).
        connectorIds: (() => {
            const AUTOMATED_SOURCES = new Set(['cron', 'github'])
            const ids = (task.context as Record<string, unknown> | null)?.connectorIds
            const fromContext = Array.isArray(ids) && ids.length > 0 ? ids as string[] : undefined
            if (fromContext === undefined && AUTOMATED_SOURCES.has(task.source ?? '')) {
                return []  // empty array → deny-all in bridge.ts
            }
            return fromContext
        })(),
        // FUN-014: checkpoint resume from a prior task's steps
        resumeFromTaskId: (task.context as Record<string, unknown> | null)?.resumeFromTaskId as string | undefined,
        // Connection & Profile Standard (ADR 0001 §3): app identity for per-(app×workspace)
        // capability enforcement. Set only when the task was dispatched by a registered app.
        // Absent for interactive/cron/dashboard tasks → tool-load enforcement is skipped.
        appId: (task.context as Record<string, unknown> | null)?.appId as string | undefined,
        // L5b (ADR 0006 §D5): metric callback for executor-side approval guard.
        // Layering: agent package owns the wrap helper; API layer owns metrics.
        onOutboundUncovered: ({ tool, provider }) => incrementCounter('plexo_outbound_tool_call_uncovered_total', { tool, provider }),
        // L5.5 #8 — fires once per (task, tool) when denial budget exhausts.
        onOutboundDenialLoop: ({ tool, provider }) => incrementCounter('plexo_outbound_denial_loop_total', { tool, provider }),
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

        // Resume entry-point: a task that was paused at the planner-gate (status
        // 'awaiting_approval' with `_resumeAt='after_planner_gate'` on context)
        // is re-claimed once the OWD_RESOLVED bus listener CAS-flips it back to
        // 'queued'. Skip planning + gate; the original run already persisted
        // tasks.plan. Clear `_resumeAt` so a future approval flow doesn't loop.
        const resumeAt = taskContext._resumeAt
        const storedPlanHash = taskContext.planHash
        const isResume = resumeAt === 'after_planner_gate' && task.plan !== null && task.plan !== undefined

        let plan: ExecutionPlan
        if (isResume) {
            plan = task.plan as ExecutionPlan
            const currentPlanHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
            if (storedPlanHash !== currentPlanHash) {
                logger.error({ taskId: task.id, storedPlanHash, currentPlanHash }, 'plan hash mismatch on resume — plan was modified after approval')
                throw new Error('Plan hash mismatch: task plan was modified after approval. Resume rejected.')
            }
            try {
                await db.update(tasks)
                    .set({ context: sql`context - '_resumeAt' - 'planHash'` })
                    .where(eq(tasks.id, task.id))
            } catch (clearErr) {
                logger.warn({ err: clearErr, taskId: task.id }, 'clear _resumeAt/planHash failed — non-fatal')
            }
            logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'awaiting_approval', to: 'running', workspaceId: taskWorkspaceId, steps: plan.steps.length }, 'resumed after planner-gate approval')
            void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'resumed', fromState: 'awaiting_approval', toState: 'running', metadata: { steps: plan.steps.length } })
            emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_resumed', taskId: task.id })
        } else {

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
            // Phase 4: leading-edge channel notification for the planning transition.
            // Skipped silently when the task didn't originate from a channel (web/api).
            const planNotifyCtx = (task.context as Record<string, unknown> | null) ?? {}
            if (planNotifyCtx.channel && planNotifyCtx.chatId) {
                const { deliverTaskTransition } = await import('./channel-delivery.js')
                void deliverTaskTransition(
                    { taskId: task.id, workspaceId: taskWorkspaceId ?? '', context: planNotifyCtx as { channel?: string; chatId?: string | number; description?: string } },
                    { state: 'planning', title: description },
                ).catch(err => logger.warn({ err, taskId: task.id }, 'planning notification failed'))
            }
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

        plan = plannerResult.plan
        logger.info({ taskId: task.id, steps: plan.steps.length, confidence: plan.confidenceScore }, 'Plan ready')
        logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'planning', to: 'executing', workspaceId: taskWorkspaceId, steps: plan.steps.length }, 'lifecycle')
        void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'executing', fromState: 'planning', toState: 'executing', metadata: { steps: plan.steps.length } })
        emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_planned', taskId: task.id, steps: plan.steps.length, confidence: plan.confidenceScore })

        const policy = await loadWorkspaceApprovalPolicy(taskWorkspaceId)

        // L5 (ADR 0006 §D2/§D3): deterministic OWD elevation for outbound
        // channel tool calls. Augments plan.oneWayDoors regardless of LLM
        // classifier verdict so Tom's persona is protected even if the
        // planner missed the irreversibility flag.
        const elevation = elevateOutboundOneWayDoors(plan)
        if (elevation.addedTools.length > 0) {
            plan.oneWayDoors = elevation.oneWayDoors
            for (const tool of elevation.addedTools) {
                const provider = tool.split('__')[0] ?? ''
                incrementCounter('plexo_owd_elevation_outbound_total', { tool, provider })
            }
            logger.info({ taskId: task.id, addedCount: elevation.addedTools.length, addedTools: elevation.addedTools }, 'OWD elevated for outbound channel tools')
        }

        // L5.5 #2 (resume-path hygiene): persist plan AFTER elevation so a
        // crash-resume reads the elevated OWDs from tasks.plan instead of the
        // un-elevated planner output. L5b's executor-side guard is the load-
        // bearing security layer; this just avoids spurious operator re-prompts
        // on resumed tasks. Non-fatal — execution proceeds even if the write fails.
        try {
            await db.update(tasks).set({ plan }).where(eq(tasks.id, task.id))
        } catch (planWriteErr) {
            logger.warn({ err: planWriteErr, taskId: task.id }, 'Persist tasks.plan failed — non-fatal')
        }

        const mustGate = plan.oneWayDoors.length > 0 || policy.requireApprovalForGeneralTasks

        // Phase F1: request approval up-front (when gated) so the inline plan
        // card carries the real approvalId. Standing approvals resolve to
        // decision='approved' inside requestApproval and skip the wait branch
        // below (preserves prior behavior).
        const owds = plan.oneWayDoors
        type ApprovalRecord = Awaited<ReturnType<typeof requestApproval>>
        let pendingApproval: ApprovalRecord | null = null
        if (mustGate) {
            const operation = owds.length > 0 ? owds[0]!.type : 'general_task'
            const owdDescription = owds.length > 0
                ? owds.map(d => d.description).join('\n')
                : plan.goal
            // ── Policy-only-gate footgun (Phase D held; Phase K Item 15b) ─────
            //
            // The CONFIRM gate has two trigger paths:
            //   1. OWD path — planner classified at least one irreversible action.
            //      operation = owds[0].type, riskLevel = 'high'. one-way-door.ts
            //      SEC-016 locks 'high'/'critical' out of standing approvals so a
            //      standing rule cannot ever silently auto-approve a real OWD.
            //   2. Policy-only path — no OWDs but the workspace has
            //      requireApprovalForGeneralTasks=true. operation = 'general_task',
            //      riskLevel = 'medium'.
            //
            // The footgun: an operator who creates a standing approval for the
            // pattern 'general_task' implicitly disables the policy-only gate
            // for ALL future tasks in that workspace. This is INTENDED for
            // operators who want a "policy on, but trust me" mode, but it's
            // easy to forget the standing rule was ever set, especially
            // wildcard ones added during onboarding.
            //
            // The OWD path is protected by SEC-016 (riskLevel='high' bypasses
            // the standing-approval check entirely). The policy-only path is
            // NOT protected — 'medium' is in scope for standing approvals by
            // design, since the gate's whole purpose is operator-discretionary.
            //
            // Decision (Phase K Item 15b, 2026-05-03): document + monitor, do
            // NOT pre-emptively escalate to 'high'. Pre-launch we have no
            // field data showing operators hit this footgun in practice; any
            // escalation now is premature optimization. Instead we instrument
            // the bypass with `plexo_policy_only_gate_standing_approval_passes_total`
            // (registered in apps/api/src/lib/metrics.ts) so we can see if the
            // pattern fires in production. If the counter is non-zero 30 days
            // post-launch, revisit and likely escalate the policy-only path
            // to 'high' so SEC-016 protects it the same way it protects OWDs.
            const riskLevel: PendingDecision['riskLevel'] = owds.length > 0 ? 'high' : 'medium'

            // F1 MVP: when steps.length < 3 the inline plan card is suppressed by emitPlanProposal's >= 3 gate, but this approvalId still exists; clients fall back to the existing task_awaiting_approval surface.
            pendingApproval = await requestApproval({
                taskId: task.id,
                workspaceId: taskWorkspaceId ?? '',
                operation,
                description: owdDescription,
                riskLevel,
            })

            // Phase K (Item 15b): track the policy-only-gate footgun. If we
            // entered this branch with no OWDs (so the gate is policy-driven,
            // not OWD-driven) AND requestApproval returned an already-approved
            // record stamped by a standing approval, then a standing rule just
            // bypassed the policy gate. Increment the counter so prod can see
            // how often this fires.
            if (owds.length === 0
                && pendingApproval.decision === 'approved'
                && typeof pendingApproval.decidedBy === 'string'
                && pendingApproval.decidedBy.startsWith('standing-approval:')) {
                incrementCounter('plexo_policy_only_gate_standing_approval_passes_total', { workspace_id: taskWorkspaceId ?? '' })
            }
        }

        // Phase F1: emit a structured plan_proposal card to the web chat plus
        // a plan_proposed lifecycle row. Helper handles the steps>=3 gate.
        emitPlanProposal({
            workspaceId: taskWorkspaceId ?? '',
            taskId: task.id,
            plan,
            requiresApproval: mustGate,
            approvalId: pendingApproval?.id ?? null,
        })

        if (mustGate) {
            // owds + pendingApproval are bound above. requestApproval was invoked
            // up-front so the plan_proposal card could carry approvalId. The
            // non-null assertion below is sound: mustGate=true is the only path
            // that assigns pendingApproval.
            const description = owds.length > 0
                ? owds.map(d => d.description).join('\n')
                : plan.goal
            const approval = pendingApproval as ApprovalRecord

            if (approval.decision !== 'approved') {
                await db.update(tasks).set({ status: 'awaiting_approval' }).where(eq(tasks.id, task.id))
                // Phase 4: persist the OWD approval id on tasks.context so inbound
                // CONFIRM/CANCEL handlers (telegram/slack/discord) can map the user's
                // reply back to the right approval without scanning Redis.
                try {
                    await db.update(tasks)
                        .set({ context: sql`context || ${JSON.stringify({ _approvalId: approval.id })}::jsonb` })
                        .where(eq(tasks.id, task.id))
                } catch (ctxWriteErr) {
                    logger.warn({ err: ctxWriteErr, taskId: task.id }, 'persist tasks.context._approvalId failed — non-fatal')
                }
                logger.info({ taskId: task.id, workspaceId: taskWorkspaceId, approvalId: approval.id, doors: owds.length, event: 'task.lifecycle', from: 'planning', to: 'awaiting_approval' }, 'task awaiting approval')
                void recordTaskEvent({
                    workspaceId: taskWorkspaceId ?? '',
                    taskId: task.id,
                    eventType: 'awaiting_approval',
                    fromState: 'planning',
                    toState: 'awaiting_approval',
                    metadata: {
                        approvalId: approval.id,
                        doors: owds.length,
                        generalPolicy: policy.requireApprovalForGeneralTasks,
                    },
                })
                emitToWorkspace(taskWorkspaceId ?? '', {
                    type: 'task_awaiting_approval',
                    taskId: task.id,
                    approvalId: approval.id,
                    doors: owds.length,
                })

                // Phase 4: leading-edge channel notification for the confirmation prompt.
                // Sent only to channels with supportsConfirmation=true (telegram/slack/discord).
                // The 6-char code is the first 6 hex chars of the OWD approval id, used
                // both for display and as a sanity-check token in the user's reply.
                const confirmCtx = (task.context as Record<string, unknown> | null) ?? {}
                if (channelSupportsConfirmation(confirmCtx.channel as string | undefined) && confirmCtx.chatId) {
                    const { deliverTaskTransition } = await import('./channel-delivery.js')
                    const confirmTitle = (confirmCtx.description as string | undefined) ?? description
                    void deliverTaskTransition(
                        { taskId: task.id, workspaceId: taskWorkspaceId ?? '', context: confirmCtx as { channel?: string; chatId?: string | number; description?: string } },
                        {
                            state: 'awaiting_confirmation',
                            title: confirmTitle,
                            stepCount: owds.length,
                            confirmationCode: approval.id.slice(0, 6),
                        },
                    ).catch(err => logger.warn({ err, taskId: task.id }, 'awaiting_confirmation notification failed'))
                }

                // Worker-slot release. When OWD_RELEASE_SLOT='planner_only', persist
                // a resume marker on context, return early, and let the OWD_RESOLVED
                // bus subscriber CAS-resume the task once the operator decides. The
                // existing finally cleans up slot + heartbeat + activeTasks. Sweeper
                // backstops the lost-event case (cleanupStaleTasks awaiting_approval
                // branch).
                if (OWD_RELEASE_SLOT) {
                    let resumePersisted = false
                    try {
                        const planHash = createHash('sha256').update(JSON.stringify(plan)).digest('hex')
                        await db.update(tasks)
                            .set({ context: sql`context || ${JSON.stringify({ _resumeAt: 'after_planner_gate', planHash })}::jsonb` })
                            .where(eq(tasks.id, task.id))
                        resumePersisted = true
                    } catch (resumeErr) {
                        logger.warn({ err: resumeErr, taskId: task.id }, 'persist _resumeAt failed — falling back to blocking wait')
                    }
                    if (resumePersisted) {
                        logger.info({ event: 'task.lifecycle', taskId: task.id, workspaceId: taskWorkspaceId, approvalId: approval.id, releasedSlot: true }, 'released slot during awaiting_approval — bus listener will resume')
                        return
                    }
                }

                const decision = await waitForDecision(approval.id)

                if (decision === 'approved') {
                    const resolved = await getDecision(approval.id)
                    await db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, task.id))
                    logger.info({ taskId: task.id, workspaceId: taskWorkspaceId, approvalId: approval.id, decidedBy: resolved?.decidedBy, event: 'task.lifecycle', from: 'awaiting_approval', to: 'running' }, 'approval granted')
                    void recordTaskEvent({
                        workspaceId: taskWorkspaceId ?? '',
                        taskId: task.id,
                        eventType: 'approval_granted',
                        fromState: 'awaiting_approval',
                        toState: 'running',
                        metadata: { approvalId: approval.id, decidedBy: resolved?.decidedBy },
                    })
                } else if (decision === 'rejected') {
                    const resolved = await getDecision(approval.id)
                    // Guard: only overwrite while still awaiting_approval (operator may have cancelled mid-wait).
                    await markTaskFailed({
                        taskId: task.id,
                        workspaceId: taskWorkspaceId ?? '',
                        failureReason: FailureReason.Cancelled,
                        errorText: 'User rejected the one-way-door approval.',
                        taskDescription: description,
                        aiSettings: aiSettings ?? undefined,
                        requireFromStatus: 'awaiting_approval',
                    })
                    logger.warn({ taskId: task.id, workspaceId: taskWorkspaceId, approvalId: approval.id, decidedBy: resolved?.decidedBy, event: 'task.lifecycle', from: 'awaiting_approval', to: 'failed' }, 'approval rejected')
                    void recordTaskEvent({
                        workspaceId: taskWorkspaceId ?? '',
                        taskId: task.id,
                        eventType: 'approval_rejected',
                        fromState: 'awaiting_approval',
                        toState: 'failed',
                        metadata: { approvalId: approval.id, decidedBy: resolved?.decidedBy },
                    })
                    emitToWorkspace(taskWorkspaceId ?? '', {
                        type: 'task_rejected',
                        taskId: task.id,
                        approvalId: approval.id,
                    })
                    return
                } else {
                    // Guard: operator may have cancelled the task during the wait.
                    // Only mark as failed-due-to-timeout if still awaiting_approval.
                    await markTaskFailed({
                        taskId: task.id,
                        workspaceId: taskWorkspaceId ?? '',
                        failureReason: FailureReason.ConfirmationExpired,
                        errorText: 'Approval window elapsed before any operator responded.',
                        taskDescription: description,
                        aiSettings: aiSettings ?? undefined,
                        requireFromStatus: 'awaiting_approval',
                    })
                    logger.warn({ taskId: task.id, workspaceId: taskWorkspaceId, approvalId: approval.id, event: 'task.lifecycle', from: 'awaiting_approval', to: 'failed' }, 'approval timed out')
                    void recordTaskEvent({
                        workspaceId: taskWorkspaceId ?? '',
                        taskId: task.id,
                        eventType: 'approval_timeout',
                        fromState: 'awaiting_approval',
                        toState: 'failed',
                        metadata: { approvalId: approval.id },
                    })
                    emitToWorkspace(taskWorkspaceId ?? '', {
                        type: 'task_rejected',
                        taskId: task.id,
                        approvalId: approval.id,
                        reason: 'timeout',
                    })
                    return
                }
            } else {
                logger.info({ taskId: task.id, approvalId: approval.id, decidedBy: approval.decidedBy }, 'CONFIRM gate auto-approved via standing approval')
                void recordTaskEvent({
                    workspaceId: taskWorkspaceId ?? '',
                    taskId: task.id,
                    eventType: 'approval_granted',
                    fromState: 'planning',
                    toState: 'running',
                    metadata: { approvalId: approval.id, decidedBy: approval.decidedBy, viaStandingApproval: true },
                })
            }
        }
        } // end of `else { /* not isResume */ }`

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

        // Log inference metrics (fire-and-forget)
        let inferenceLogId: string | undefined
        try {
            const taskCtx = (task.context as Record<string, unknown>) ?? {}
            const text = `${String(taskCtx.instructions ?? taskCtx.goal ?? task.type ?? '')} ${task.type ?? ''}`.toLowerCase()
            const regionKeywords: Record<string, string[]> = {
                'code': ['code', 'function', 'bug', 'refactor', 'typescript', 'javascript', 'python', 'api', 'endpoint', 'test', 'build', 'compile', 'deploy', 'git', 'commit', 'pr', 'lint', 'fix'],
                'writing': ['write', 'draft', 'edit', 'blog', 'article', 'copy', 'email', 'document', 'summary', 'report', 'prose', 'content', 'changelog', 'readme'],
                'data-analysis': ['data', 'analyze', 'csv', 'spreadsheet', 'chart', 'graph', 'metrics', 'dashboard', 'sql', 'query', 'aggregate', 'statistics', 'trend'],
                'planning': ['plan', 'roadmap', 'strategy', 'architecture', 'design', 'spec', 'requirements', 'milestone', 'sprint', 'scope', 'estimate', 'breakdown'],
                'research': ['research', 'investigate', 'find', 'search', 'compare', 'evaluate', 'benchmark', 'alternatives', 'options', 'audit', 'review'],
                'qa': ['test', 'qa', 'verify', 'validate', 'check', 'assert', 'regression', 'coverage', 'e2e', 'integration', 'unit test'],
                'conversation': ['chat', 'ask', 'explain', 'help', 'question', 'answer', 'clarify', 'discuss'],
                'creative': ['design', 'creative', 'brainstorm', 'ideate', 'generate', 'imagine', 'concept', 'prototype', 'mockup', 'ui', 'ux'],
            }
            let bestRegion = 'conversation'
            let bestScore = 0
            for (const [region, keywords] of Object.entries(regionKeywords)) {
                const score = keywords.filter(kw => text.includes(kw)).length
                if (score > bestScore) { bestScore = score; bestRegion = region }
            }
            const rows = await db.execute<{ id: string }>(sql`
                INSERT INTO inference_logs (instance_uuid, model, provider, input_tokens, output_tokens, latency_ms, domain_region, task_type, success)
                VALUES (${process.env.PLEXO_INSTANCE_ID ?? 'unknown'}, ${ctx.activeModel ?? 'unknown'}, ${ctx.activeProvider ?? 'unknown'},
                        ${result.totalTokensIn}, ${result.totalTokensOut}, ${result.totalDurationMs},
                        ${bestRegion}, ${task.type ?? 'unknown'}, ${result.ok})
                RETURNING id
            `)
            inferenceLogId = rows[0]?.id
        } catch (logErr) {
            logger.warn({ err: logErr, taskId: task.id }, 'Inference log write failed (non-fatal)')
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
                // Round-5 Phase 6: capture the prior alerted_80 so we can detect
                // the false→true crossing and fire a pre-ceiling alert exactly
                // once per workspace per week (not once per task past 80%).
                // A6 cutover: dual-write cost_usd + cost_usd_numeric, ceiling_usd
                // + ceiling_usd_numeric. SQL accumulation uses the numeric path
                // for the 80% trigger so roundoff at edge-of-ceiling stays exact.
                // Old real cols are kept in lockstep until the Phase 4 contract.
                const costRows = await db.execute<{
                    cost_usd: number; ceiling_usd: number;
                    cost_usd_numeric: string | null; ceiling_usd_numeric: string | null;
                    now_alerted: boolean; was_alerted: boolean
                }>(sql`
                    WITH prev AS (
                        SELECT alerted_80 AS was
                        FROM api_cost_tracking
                        WHERE workspace_id = ${taskWorkspaceId ?? ''}::uuid
                          AND week_start = date_trunc('week', NOW())::date
                    ),
                    upserted AS (
                        INSERT INTO api_cost_tracking (id, workspace_id, week_start, cost_usd, ceiling_usd, cost_usd_numeric, ceiling_usd_numeric, alerted_80)
                        VALUES (
                            gen_random_uuid(),
                            ${taskWorkspaceId ?? ''}::uuid,
                            date_trunc('week', NOW())::date,
                            ${result.totalCostUsd},
                            ${API_COST_CEILING},
                            ${result.totalCostUsd}::numeric,
                            ${API_COST_CEILING}::numeric,
                            false
                        )
                        ON CONFLICT (workspace_id, week_start)
                        DO UPDATE SET
                            cost_usd = api_cost_tracking.cost_usd + EXCLUDED.cost_usd,
                            cost_usd_numeric = COALESCE(api_cost_tracking.cost_usd_numeric, 0::numeric) + EXCLUDED.cost_usd_numeric,
                            ceiling_usd_numeric = COALESCE(api_cost_tracking.ceiling_usd_numeric, EXCLUDED.ceiling_usd_numeric),
                            alerted_80 = CASE
                                WHEN (COALESCE(api_cost_tracking.cost_usd_numeric, 0::numeric) + EXCLUDED.cost_usd_numeric)
                                     >= (COALESCE(api_cost_tracking.ceiling_usd_numeric, EXCLUDED.ceiling_usd_numeric) * 0.8)
                                THEN true
                                ELSE api_cost_tracking.alerted_80
                            END
                        RETURNING cost_usd, ceiling_usd, cost_usd_numeric, ceiling_usd_numeric, alerted_80
                    )
                    SELECT u.cost_usd, u.ceiling_usd, u.cost_usd_numeric, u.ceiling_usd_numeric,
                           u.alerted_80 AS now_alerted,
                           COALESCE(p.was, false) AS was_alerted
                    FROM upserted u LEFT JOIN prev p ON true
                `)
                logger.info({ taskId: task.id, costUsd: result.totalCostUsd }, 'api_cost_tracking updated')

                const costRow = costRows[0]
                if (costRow && costRow.now_alerted && !costRow.was_alerted) {
                    try {
                        const { recordBudgetAlertForAlert } = await import('./ops-alerts.js')
                        // A6 cutover: prefer numeric col; fall back to real if backfill missed a row.
                        const alertCostMicro = toMicro(costRow.cost_usd_numeric ?? costRow.cost_usd)
                        const alertCeilMicro = toMicro(costRow.ceiling_usd_numeric ?? costRow.ceiling_usd)
                        recordBudgetAlertForAlert({
                            workspaceId: taskWorkspaceId ?? '',
                            costUsd: microToNumber(alertCostMicro),
                            ceilingUsd: microToNumber(alertCeilMicro),
                        })
                        logger.warn({ taskId: task.id, workspaceId: taskWorkspaceId, costUsd: microToNumber(alertCostMicro), ceilingUsd: microToNumber(alertCeilMicro) }, 'workspace crossed 80% weekly cost ceiling — ops alert queued')
                    } catch (alertErr) {
                        logger.warn({ err: alertErr, taskId: task.id }, 'budget alert enqueue failed — non-fatal')
                    }
                }
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

        // ── TASK_COMPLETED event ───────────────────────────────────────────────
        // Single fan-out point: reflect.ts writes the semantic memory entry,
        // consolidation.ts checks anti-bloat thresholds. Both subscribe to
        // TOPICS.TASK_COMPLETED so this publish is the only call site.
        try {
            const taskCtxForEvent = task.context as Record<string, unknown> | null | undefined
            const description = (taskCtxForEvent?.description as string)
                ?? (taskCtxForEvent?.message as string)
                ?? task.type
            const toolsUsedForEvent = [...new Set(
                (result.steps ?? []).flatMap(s => (s.toolCalls ?? []).map(tc => tc.tool))
            )]
            const completedPayload: TaskCompletedPayload = {
                taskId: task.id,
                workspaceId: taskWorkspaceId ?? '',
                description,
                outcome: result.ok ? 'success' : 'partial',
                outcomeSummary: result.outcomeSummary?.slice(0, 2000),
                // Phase M: score may be pending (judge runs off the hot path) → omit it.
                qualityScore: result.qualityScore ?? undefined,
                durationMs: Date.now() - taskStartMs,
                toolsUsed: toolsUsedForEvent,
                parentTaskId: task.parentId ?? null,
            }
            eventBus.publish(TOPICS.TASK_COMPLETED, completedPayload)
        } catch (publishErr) {
            logger.warn({ err: publishErr, taskId: task.id }, 'TASK_COMPLETED publish failed — non-fatal')
        }

        // ── Task-completion memory write (L2 memory-write architecture, 2026-05-23) ──
        // Pre-L2 fix: extractConversationMemory only fired inside the
        // intent==='CONVERSATION' branch of channel adapters, so the
        // bulk of production traffic (task paths) wrote zero memory.
        // This hook captures every completed task as a 'task' memory
        // entry — type matches MemoryType ('task'|'incident'|'session'|
        // 'pattern'). Postgres-only since the graphiti retirement
        // (2026-06-27). Fire-and-forget; never blocks lifecycle.
        if (taskWorkspaceId) {
            try {
                const taskCtxForMemory = task.context as Record<string, unknown> | null | undefined
                const descriptionForMemory = (taskCtxForMemory?.description as string)
                    ?? (taskCtxForMemory?.message as string)
                    ?? task.type
                const outcomeForMemory = result.ok ? 'success' : 'partial'
                const summaryForMemory = result.outcomeSummary?.slice(0, 2000) ?? ''
                const memoryType = result.ok ? 'task' as const : 'incident' as const
                const memoryContent = summaryForMemory
                    ? `Task: ${descriptionForMemory}\nOutcome: ${outcomeForMemory}\n${summaryForMemory}`
                    : `Task: ${descriptionForMemory}\nOutcome: ${outcomeForMemory}`
                const toolsUsedForMemory = [...new Set(
                    (result.steps ?? []).flatMap(s => (s.toolCalls ?? []).map(tc => tc.tool))
                )]
                void storeMemory({
                    workspaceId: taskWorkspaceId,
                    type: memoryType,
                    content: memoryContent,
                    metadata: {
                        taskId: task.id,
                        taskType: task.type,
                        outcome: outcomeForMemory,
                        qualityScore: result.qualityScore,
                        durationMs: Date.now() - taskStartMs,
                        toolsUsed: toolsUsedForMemory,
                        costUsd: result.totalCostUsd,
                        parentTaskId: task.parentId ?? null,
                    },
                }).catch((err) => {
                    logger.warn({ err, taskId: task.id, workspaceId: taskWorkspaceId }, 'task-completion memory write failed — non-fatal')
                })
            } catch (memoryErr) {
                logger.warn({ err: memoryErr, taskId: task.id }, 'task-completion memory build failed — non-fatal')
            }
        }

        // ── Post-task reflection (non-fatal) ──────────────────────────────────
        // When scl_enabled=true, this drives Golden Record mutation (structured
        // concepts + relations). Otherwise it is gated by workspace preference
        // `reflection_enabled` and produces text-based behavior rules.
        // Phase M: when the score is pending (null), reflection is handled off
        // the hot path by the executor's detached judge block (with the real
        // verified score). Only reflect here for paths that carry a settled
        // score (executor early-exit/error returns) — and never feed a null
        // score into reflectAndPromote, whose threshold logic treats null as 0
        // and would misroute to the failure track.
        if (result.qualityScore != null) {
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
                        track: reflectResult.track,
                        observationCount: reflectResult.observationCount,
                        taskType: task.type,
                    })
                }

            } catch (reflectErr) {
                logger.warn({ err: reflectErr, taskId: task.id }, 'reflectAndPromote failed — non-fatal')
            }
        }

        // Phase M: judge metadata (context._judge) is now patched onto the task
        // row by the executor's detached judge block, alongside the settled
        // quality score — no longer carried back on the execution result.

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

        // Phase C: outcome capture — non-fatal, gated behind OUTCOME_CAPTURE_ENABLED flag.
        {
            const { recordOutcome, buildOutcomePayload } = await import('./outcome-capture.js')
            void recordOutcome(buildOutcomePayload({
                taskId: task.id,
                taskSource: task.source,
                context: task.context as Record<string, unknown> | null,
                outcomeSummary: result.outcomeSummary,
                automatedOutcome: 'complete',
            })).catch(() => { /* non-fatal */ })
        }

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
            // Billing / credit-balance exhaustion across the whole fallback
            // chain. withFallback already advances on 402 from the primary,
            // but if every provider in the chain is depleted the error
            // bubbles up here — treat it as transient so the task requeues
            // (operator may top up between attempts) instead of permanently
            // failing.
            /402/, /credit balance/i, /insufficient credits/i,
            /insufficient_quota/i, /payment required/i,
        ]
        const isTransient = TRANSIENT_PATTERNS.some(p => p.test(message))
            || errCode === 'CALL_MODEL_TIMEOUT'
            || errCode === 'CALL_MODEL_RATE_LIMIT'
            || errCode === 'CALL_MODEL_OVERLOADED'

        let failSummary: EscalationSummary | undefined
        if (isTransient) {
            const retryResult = await requeueForRetry(task.id, { maxAttempts: 3, backoffBase: 60 })
            logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'running', to: retryResult === 'requeued' ? 'queued' : 'failed', workspaceId: taskWorkspaceId, durationMs: Date.now() - taskStartMs, error: message.slice(0, 200), code: errCode, retryResult }, 'lifecycle')
            void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: retryResult === 'requeued' ? 'requeued' : 'failed', fromState: 'running', toState: retryResult === 'requeued' ? 'queued' : 'failed', metadata: { durationMs: Date.now() - taskStartMs, error: message.slice(0, 200), code: errCode, retryResult } })
            trackEvent('task.retried', 'info', { taskId: task.id, error: message, code: errCode ?? undefined, workspaceId: taskWorkspaceId, retryResult })
            if (retryResult === 'max_attempts') {
                // requeueForRetry just transitioned status='failed' but did not
                // populate failed_at / failure_reason / structured outcome. Fill
                // those in and emit the TASK_FAILED event for downstream listeners.
                const failCtx = (task.context as Record<string, unknown>) ?? {}
                const failDesc = (failCtx.description as string) ?? (failCtx.message as string) ?? task.type ?? 'task'
                const transientFail = await markTaskFailed({
                    taskId: task.id,
                    workspaceId: taskWorkspaceId ?? '',
                    failureReason: FailureReason.MaxAttemptsExceeded,
                    errorText: reasonPrefix + message,
                    taskDescription: failDesc,
                    aiSettings: aiSettings ?? undefined,
                    attempts: 3,
                })
                failSummary = transientFail.summary
                await syncSprintTaskBlocked(task, `Failed after retries: ${reasonPrefix}${message}`)
            }
        } else {
            const errCtx = (task.context as Record<string, unknown>) ?? {}
            const errDesc = (errCtx.description as string) ?? (errCtx.message as string) ?? task.type ?? 'task'
            // Label capability gaps (no deploy/host/integration) distinctly from
            // genuine tool crashes. Conservative — defaults to ToolError.
            // Phase N (Slice 2) handles the graceful case UPSTREAM in the executor:
            // a capability gap WITH a deliverable returns ok:true (complete +
            // limitation marker) and never reaches here. So this path is now only
            // the no-deliverable capability gap → fail honestly as
            // capability_unavailable (vs a real tool crash → tool_error).
            const nonTransientReason = classifyCapabilityGap(message)
                ? FailureReason.CapabilityUnavailable
                : FailureReason.ToolError
            const nonTransientFail = await markTaskFailed({
                taskId: task.id,
                workspaceId: taskWorkspaceId ?? '',
                failureReason: nonTransientReason,
                errorText: reasonPrefix + message,
                taskDescription: errDesc,
                aiSettings: aiSettings ?? undefined,
            })
            failSummary = nonTransientFail.summary
            logger.info({ event: 'task.lifecycle', taskId: task.id, from: 'running', to: 'failed', workspaceId: taskWorkspaceId, durationMs: Date.now() - taskStartMs, error: message.slice(0, 200), code: errCode }, 'lifecycle')
            void recordTaskEvent({ workspaceId: taskWorkspaceId ?? '', taskId: task.id, eventType: 'failed', fromState: 'running', toState: 'failed', metadata: { durationMs: Date.now() - taskStartMs, error: message.slice(0, 200), code: errCode } })
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

        emitTaskOutcome({
            type: task.type ?? 'unknown',
            source: task.source ?? 'unknown',
            success: false,
            durationMs: Date.now() - taskStartMs,
            costUsd: 0,
            provider: ctx.activeProvider,
            stepCount: 0,
        })

        // Phase C: outcome capture on failed path — gated behind OUTCOME_CAPTURE_ENABLED.
        {
            const { recordOutcome, buildOutcomePayload } = await import('./outcome-capture.js')
            const failedOutcome = errCode === 'COST_CEILING' ? 'cost_ceiling' as const
                : errCode === 'NO_CREDENTIAL' ? 'no_credential' as const
                : 'failed' as const
            void recordOutcome(buildOutcomePayload({
                taskId: task.id,
                taskSource: task.source,
                context: task.context as Record<string, unknown> | null,
                outcomeSummary: message.slice(0, 2000),
                automatedOutcome: failedOutcome,
            })).catch(() => { /* non-fatal */ })
        }

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

        emitToWorkspace(taskWorkspaceId ?? '', { type: 'task_failed', taskId: task.id, error: message, summary: failSummary })
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

/** Stale-task sweeper.
 *  Three branches:
 *    1. Claim expired (status in 'claimed'|'running', claimed_until < now): requeue or
 *       fail via markTaskFailed once retries exhaust. Worker died or lost heartbeat.
 *    2. Blocked too long: defaults to 2h. Per-task override via tasks.wall_clock_limit_sec.
 *    3. Queued too long: defaults to 7d. Per-task override via tasks.wall_clock_limit_sec.
 *  Branches 2 and 3 fail via markTaskFailed (FailureReason.WallClockExceeded) so the
 *  user gets a structured escalation and the row emits TASK_FAILED for the reflect
 *  listener — replaces the prior bulk-cancel that silently dropped these tasks. */
async function cleanupStaleTasks(): Promise<void> {
    try {
        // 1. Find tasks whose claim has expired in either claimed or running state.
        const expired = await db.execute<{ id: string; workspace_id: string; status: string; context: Record<string, unknown> | null; type: string | null }>(sql`
            SELECT id, workspace_id, status, context, type FROM tasks
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
                if (retryResult === 'max_attempts') {
                    const ctx = row.context ?? {}
                    const desc = (ctx.description as string) ?? (ctx.message as string) ?? row.type ?? 'task'
                    await markTaskFailed({
                        taskId: row.id,
                        workspaceId: row.workspace_id,
                        failureReason: FailureReason.WallClockExceeded,
                        errorText: 'Task claim expired repeatedly — worker likely hung or crashed before completing.',
                        taskDescription: desc,
                        attempts: 3,
                    })
                }
            }
        }

        // 2. & 3. Tasks past their wall-clock budget while still 'blocked' or 'queued'.
        // Defaults: 2h blocked, 7d queued. Per-task override via tasks.wall_clock_limit_sec
        // applies the same value to whichever state the task is currently in.
        const stale = await db.execute<{
            id: string
            workspace_id: string
            status: 'queued' | 'blocked' | 'awaiting_approval'
            context: Record<string, unknown> | null
            type: string | null
        }>(sql`
            SELECT id, workspace_id, status, context, type FROM tasks
            WHERE (
                status = 'blocked'
                AND created_at < NOW() - (COALESCE(wall_clock_limit_sec, 7200) * INTERVAL '1 second')
            ) OR (
                status = 'queued'
                AND created_at < NOW() - (COALESCE(wall_clock_limit_sec, 604800) * INTERVAL '1 second')
            ) OR (
                status = 'awaiting_approval'
                AND created_at < NOW() - (COALESCE(wall_clock_limit_sec, 86400) * INTERVAL '1 second')
            )
            LIMIT 50
        `)
        if (stale.length > 0) {
            const sprintIds: string[] = []
            for (const row of stale) {
                const ctx = row.context ?? {}
                const desc = (ctx.description as string) ?? (ctx.message as string) ?? row.type ?? 'task'
                const errorText = row.status === 'blocked'
                    ? 'Task remained in blocked state past its wall-clock budget — likely waiting on a clarification or approval that never arrived.'
                    : row.status === 'awaiting_approval'
                    ? 'Approval window elapsed before any operator responded.'
                    : 'Task sat in the queue past its wall-clock budget — capacity never freed up to run it.'
                const failureReason = row.status === 'awaiting_approval'
                    ? FailureReason.ConfirmationExpired
                    : FailureReason.WallClockExceeded
                await markTaskFailed({
                    taskId: row.id,
                    workspaceId: row.workspace_id,
                    failureReason,
                    errorText,
                    taskDescription: desc,
                })
                logger.info({ event: 'task.lifecycle', taskId: row.id, from: row.status, to: 'failed', workspaceId: row.workspace_id, reason: 'wall_clock_exceeded' }, 'lifecycle')
                void recordTaskEvent({ workspaceId: row.workspace_id, taskId: row.id, eventType: 'wall_clock_exceeded', fromState: row.status, toState: 'failed', metadata: { reason: 'wall_clock_exceeded', priorStatus: row.status } })
                const sprintTaskId = ctx.sprintTaskId as string | undefined
                if (sprintTaskId) sprintIds.push(sprintTaskId)
            }
            logger.info({ count: stale.length }, 'Failed stale blocked/queued tasks (wall_clock_exceeded)')
            if (sprintIds.length > 0) {
                await db.update(sprintTasks)
                    .set({
                        status: 'failed',
                        handoff: sql`COALESCE(handoff, '{}'::jsonb) || ${JSON.stringify({ outcome: 'wall_clock_exceeded' })}::jsonb`,
                    })
                    .where(inArray(sprintTasks.id, sprintIds))
                logger.info({ count: sprintIds.length }, 'Sprint tasks status synced in batch')
            }
        }
    } catch (err) {
        logger.warn({ err }, 'Stale task cleanup failed — non-fatal')
    }
}

// Mark long-failed tasks as archive-ready so the downstream archive job
// (nexalog stale-archive endpoint, scanner, ops tooling) has an explicit
// signal to act on. The task row itself is left intact — failure_reason and
// outcome_summary remain queryable, which is what the breaker scanner needs.
//
// Tasks failed downstream of a disabled provider (no_ai_credential) emit the
// event with reason='provider_disabled'; the consumer can choose to defer
// archive until the credential is rotated.
async function markFailedTasksArchiveReady(): Promise<void> {
    try {
        const candidates = await db.execute<{ id: string; workspace_id: string; failure_reason: string | null }>(sql`
            SELECT t.id, t.workspace_id, t.failure_reason FROM tasks t
            WHERE t.status = 'failed'
              AND t.failed_at IS NOT NULL
              AND t.failed_at < NOW() - INTERVAL '2 hours'
              AND NOT EXISTS (
                  SELECT 1 FROM plexo_ops_task_events e
                  WHERE e.task_id = t.id AND e.event_type = 'archive_ready'
              )
            LIMIT 200
        `)
        if (candidates.length === 0) return
        for (const row of candidates) {
            const reason = row.failure_reason === 'no_ai_credential' ? 'provider_disabled' : 'wall_clock_archive'
            void recordTaskEvent({
                workspaceId: row.workspace_id,
                taskId: row.id,
                eventType: 'archive_ready',
                fromState: 'failed',
                toState: 'failed',
                metadata: { reason, failureReason: row.failure_reason },
            })
        }
        logger.info({ count: candidates.length }, 'Marked failed tasks as archive_ready')
    } catch (err) {
        logger.warn({ err }, 'archive_ready sweep failed — non-fatal')
    }
}

// Belt-and-suspenders backstop for cleanupStaleTasks — covers any running task whose claimed_until somehow wasn't set or wasn't picked up by the primary sweep.
async function recoverGhostTasks(): Promise<void> {
    try {
        const ghosts = await db.execute<{ id: string; workspace_id: string; context: Record<string, unknown> | null; type: string | null }>(sql`
            SELECT id, workspace_id, context, type FROM tasks
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
            if (outcome === 'max_attempts') {
                const ctx = ghost.context ?? {}
                const desc = (ctx.description as string) ?? (ctx.message as string) ?? ghost.type ?? 'task'
                await markTaskFailed({
                    taskId: ghost.id,
                    workspaceId: ghost.workspace_id,
                    failureReason: FailureReason.WallClockExceeded,
                    errorText: 'Task running without heartbeat for too long — worker likely crashed.',
                    taskDescription: desc,
                    attempts: 3,
                })
            }
        }
    } catch (err) {
        logger.warn({ err }, 'Ghost task recovery failed — non-fatal')
    }
}

let _owdResolvedListenerInitialized = false

async function initOwdResolvedListener(): Promise<void> {
    if (_owdResolvedListenerInitialized) return
    _owdResolvedListenerInitialized = true

    const { eventBus, TOPICS } = await import('@plexo/agent/event-bus')

    eventBus.subscribe(TOPICS.OWD_RESOLVED, async (raw: unknown) => {
        try {
            const r = raw as { id?: string; taskId?: string; workspaceId?: string; decision?: 'approved' | 'rejected'; decidedBy?: string }
            if (!r?.id || !r?.taskId || !r?.workspaceId || (r.decision !== 'approved' && r.decision !== 'rejected')) return

            if (r.decision === 'approved') {
                // Status-CAS resume: only if still awaiting_approval. Clear claim
                // accounting so claimBatch picks up cleanly.
                const result = await db.execute<{ id: string }>(sql`
                    UPDATE tasks
                    SET status = 'queued', claimed_at = NULL, claimed_until = NULL, retry_after = NULL
                    WHERE id = ${r.taskId} AND status = 'awaiting_approval'
                    RETURNING id
                `)
                if (result.length > 0) {
                    logger.info({ taskId: r.taskId, approvalId: r.id, decidedBy: r.decidedBy, event: 'task.lifecycle', from: 'awaiting_approval', to: 'queued' }, 'OWD_RESOLVED: requeued for resume')
                    void recordTaskEvent({ workspaceId: r.workspaceId, taskId: r.taskId, eventType: 'approval_granted', fromState: 'awaiting_approval', toState: 'queued', metadata: { approvalId: r.id, decidedBy: r.decidedBy, viaSlotRelease: true } })
                    emitToWorkspace(r.workspaceId, { type: 'task_approved', taskId: r.taskId, approvalId: r.id })
                }
                // No row returned → the task was already cancelled / failed /
                // resumed by another path. Idempotent no-op.
            } else {
                // rejected: terminate. Look up task for description; markTaskFailed
                // is requireFromStatus-guarded so concurrent cancels don't race.
                const [row] = await db.select({ context: tasks.context, workspaceId: tasks.workspaceId, type: tasks.type, status: tasks.status })
                    .from(tasks).where(eq(tasks.id, r.taskId)).limit(1)
                if (!row || row.status !== 'awaiting_approval') return
                const taskCtx = (row.context ?? {}) as Record<string, unknown>
                const desc = (taskCtx.description as string) ?? (taskCtx.message as string) ?? row.type ?? 'task'
                await markTaskFailed({
                    taskId: r.taskId,
                    workspaceId: row.workspaceId ?? r.workspaceId,
                    failureReason: FailureReason.Cancelled,
                    errorText: 'User rejected the one-way-door approval.',
                    taskDescription: desc,
                    requireFromStatus: 'awaiting_approval',
                })
                logger.info({ taskId: r.taskId, approvalId: r.id, decidedBy: r.decidedBy, event: 'task.lifecycle', from: 'awaiting_approval', to: 'failed' }, 'OWD_RESOLVED: rejected — task failed')
                void recordTaskEvent({ workspaceId: r.workspaceId, taskId: r.taskId, eventType: 'approval_rejected', fromState: 'awaiting_approval', toState: 'failed', metadata: { approvalId: r.id, decidedBy: r.decidedBy, viaSlotRelease: true } })
                emitToWorkspace(r.workspaceId, { type: 'task_rejected', taskId: r.taskId, approvalId: r.id })
            }
        } catch (err) {
            logger.warn({ err }, 'OWD_RESOLVED listener errored — non-fatal')
        }
    })

    logger.info('OWD_RESOLVED listener registered (worker-slot release mode)')
}

export function startAgentLoop(): void {
    logger.info('Agent queue loop started')

    // Clean up stale blocked tasks at startup + every 30 minutes
    void cleanupStaleTasks()
    setInterval(() => { void cleanupStaleTasks() }, 30 * 60 * 1000)

    // Mark long-failed tasks archive_ready — every 30 minutes
    void markFailedTasksArchiveReady()
    setInterval(() => { void markFailedTasksArchiveReady() }, 30 * 60 * 1000)

    // Ghost task recovery — every 5 minutes
    void recoverGhostTasks()
    setInterval(() => { void recoverGhostTasks() }, 5 * 60 * 1000)

    // OWD_RESOLVED bus subscriber — only registered when slot-release is on,
    // because the legacy waitForDecision poll handles the resume path otherwise
    // and double-handling would race with the existing inline status writes.
    if (OWD_RELEASE_SLOT) {
        void initOwdResolvedListener().catch((err) => logger.warn({ err }, 'OWD_RESOLVED listener init failed — non-fatal'))
    }

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
