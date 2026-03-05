import { claimTask, completeTask, blockTask } from '@plexo/queue'
import { db, eq } from '@plexo/db'
import { tasks, workspaces } from '@plexo/db'
import { planTask } from '@plexo/agent/planner'
import { executeTask } from '@plexo/agent/executor'
import type { AnthropicCredential, ExecutionContext } from '@plexo/agent/types'
import type { WorkspaceAISettings, ProviderKey } from '@plexo/agent/providers/registry'
import { logger } from './logger.js'
import { emit } from './sse-emitter.js'
import { getAnthropicTokens } from './anthropic-tokens.js'

const POLL_INTERVAL_MS = 2_000
const API_COST_CEILING = parseFloat(process.env.API_COST_CEILING_USD ?? '10')

let running = true
let activeAbort: AbortController | null = null

/**
 * Load workspace AI settings and resolve the first usable credential.
 * Checks the full fallback chain (primary → fallbacks) so that if Anthropic
 * isn't configured but OpenAI is, the task proceeds and withFallback() in
 * the executor handles provider selection.
 */
async function loadWorkspaceAISettings(workspaceId: string): Promise<{
    credential: AnthropicCredential | null
    aiSettings: WorkspaceAISettings | null
}> {
    if (!workspaceId) return { credential: null, aiSettings: null }

    let aiSettings: WorkspaceAISettings | null = null
    let providers: Record<string, { apiKey?: string; oauthToken?: string; baseUrl?: string; defaultModel?: string }> = {}

    try {
        const [ws] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        const s = ws?.settings as {
            aiProviders?: {
                primaryProvider?: string
                fallbackChain?: string[]
                providers?: Record<string, { apiKey?: string; oauthToken?: string; baseUrl?: string; defaultModel?: string }>
            }
        } | null
        if (s?.aiProviders) {
            const ap = s.aiProviders
            providers = ap.providers ?? {}
            aiSettings = {
                primaryProvider: (ap.primaryProvider ?? 'anthropic') as ProviderKey,
                fallbackChain: (ap.fallbackChain ?? []) as ProviderKey[],
                providers: Object.fromEntries(
                    Object.entries(providers).map(([k, v]) => [k, {
                        provider: k as ProviderKey,
                        apiKey: v.apiKey,
                        baseUrl: v.baseUrl,
                        defaultModel: v.defaultModel,
                    }])
                ) as WorkspaceAISettings['providers'],
            }
        }
    } catch (err) {
        logger.warn({ err }, 'Failed to load workspace AI settings')
    }

    // 1. Env var override (Anthropic direct key only)
    const envKey = process.env.ANTHROPIC_API_KEY
    if (envKey && envKey !== 'placeholder' && !envKey.startsWith('sk-ant-oat')) {
        return { credential: { type: 'api_key', apiKey: envKey }, aiSettings }
    }

    // 2. Walk the fallback chain — any provider with a configured key unblocks execution
    const chain = [aiSettings?.primaryProvider, ...(aiSettings?.fallbackChain ?? [])].filter(Boolean) as string[]
    for (const providerKey of chain) {
        const p = providers[providerKey]
        if (!p) continue
        if (providerKey === 'anthropic') {
            if (p.oauthToken) return { credential: { type: 'api_key', apiKey: p.oauthToken }, aiSettings }
            if (p.apiKey && p.apiKey !== 'placeholder') return { credential: { type: 'api_key', apiKey: p.apiKey }, aiSettings }
        } else if (p.apiKey && p.apiKey !== 'placeholder') {
            // Non-Anthropic key — credential acts as a gate sentinel; withFallback() in the executor picks the actual model
            return { credential: { type: 'api_key', apiKey: p.apiKey }, aiSettings }
        }
    }

    // 3. Installed OAuth token (Claude.ai subscription)
    try {
        const tokens = await getAnthropicTokens(workspaceId)
        if (tokens?.accessToken) {
            return { credential: { type: 'api_key', apiKey: tokens.accessToken }, aiSettings }
        }
    } catch { /* non-fatal */ }

    return { credential: null, aiSettings }
}

async function processOneTask(): Promise<boolean> {
    const task = await claimTask('agent-loop-1')
    if (!task) return false

    logger.info({ taskId: task.id, type: task.type }, 'Task claimed')
    emit({ type: 'task_started', taskId: task.id, taskType: task.type })

    const { credential, aiSettings } = await loadWorkspaceAISettings(task.workspaceId)
    if (!credential) {
        await blockTask(task.id, 'No AI credential configured for workspace')
        emit({ type: 'task_blocked', taskId: task.id, reason: 'No AI credential' })
        logger.warn({ taskId: task.id, workspaceId: task.workspaceId }, 'No credential — task blocked')
        return true
    }

    const abort = new AbortController()
    activeAbort = abort

    const ctx: ExecutionContext = {
        taskId: task.id,
        workspaceId: task.workspaceId,
        userId: 'system',
        credential,
        tokenBudget: Math.floor((API_COST_CEILING * 1_000_000) / 15),
        signal: abort.signal,
    }

    try {
        await db.update(tasks)
            .set({ status: 'running', claimedAt: new Date() })
            .where(eq(tasks.id, task.id))

        const taskContext = task.context as Record<string, unknown>
        const description = (taskContext.description as string) ?? JSON.stringify(taskContext)

        emit({ type: 'task_planning', taskId: task.id })
        const plan = await planTask(ctx, description, taskContext)
        logger.info({ taskId: task.id, steps: plan.steps.length, confidence: plan.confidenceScore }, 'Plan ready')
        emit({ type: 'task_planned', taskId: task.id, steps: plan.steps.length, confidence: plan.confidenceScore })

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

        emit({
            type: 'task_complete',
            taskId: task.id,
            qualityScore: result.qualityScore,
            costUsd: result.totalCostUsd,
            summary: result.outcomeSummary,
        })
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error({ taskId: task.id, err }, 'Task failed')
        await blockTask(task.id, message)
        emit({ type: 'task_failed', taskId: task.id, error: message })
    } finally {
        activeAbort = null
    }

    return true
}

export function startAgentLoop(): void {
    logger.info('Agent queue loop started')

    async function poll(): Promise<void> {
        while (running) {
            try {
                await processOneTask()
            } catch (err) {
                logger.error({ err }, 'Queue loop error')
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        }
    }

    poll().catch((err) => logger.fatal({ err }, 'Agent loop crashed'))
}

export function stopAgentLoop(): void {
    running = false
    activeAbort?.abort()
    logger.info('Agent queue loop stopped')
}
