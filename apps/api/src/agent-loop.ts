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
    if (!workspaceId) {
        logger.warn('loadWorkspaceAISettings called with no workspaceId')
        return { credential: null, aiSettings: null }
    }

    let aiSettings: WorkspaceAISettings | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawProviders: Record<string, any> = {}

    try {
        const [ws] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = ws?.settings as any
        const ap = s?.aiProviders

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
                        hasOAuthToken: !!(p.oauthToken),
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
                primaryProvider: (ap.primary ?? ap.primaryProvider ?? 'anthropic') as ProviderKey,
                fallbackChain: (ap.fallbackOrder ?? ap.fallbackChain ?? []) as ProviderKey[],
                providers: Object.fromEntries(
                    providerKeys.map((k) => {
                        const p = rawProviders[k]
                        return [k, {
                            provider: k as ProviderKey,
                            apiKey: p.apiKey,
                            oauthToken: p.oauthToken,
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

    // 1. Env var override (Anthropic direct key only, not OAuth tokens)
    const envKey = process.env.ANTHROPIC_API_KEY
    if (envKey && envKey !== 'placeholder' && !envKey.startsWith('sk-ant-oat')) {
        logger.info({ workspaceId }, 'ai-cred: using ANTHROPIC_API_KEY env var override')
        return { credential: { type: 'api_key', apiKey: envKey }, aiSettings }
    }

    // 2. Walk the full provider chain — first one with a usable credential wins.
    //    IMPORTANT: also update aiSettings.primaryProvider to match the winning provider
    //    so resolveModel() builds the correct model, not the un-keyed primary.
    const primaryProvider = aiSettings?.primaryProvider ?? 'anthropic'
    const fallbackChain = aiSettings?.fallbackChain ?? []
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
        const p = rawProviders[providerKey]
        if (!p) {
            logger.debug({ workspaceId, providerKey }, 'ai-cred: provider not in DB — skip')
            continue
        }

        const apiKey = p.apiKey as string | undefined
        const oauthToken = p.oauthToken as string | undefined
        const baseUrl = p.baseUrl as string | undefined
        const status = p.status as string | undefined

        // Basic validity checks — expired OAuth tokens look valid but aren't.
        // A token with spaces, wrong prefix, or under 20 chars is rejected so we fall through.
        const isValidOAuthToken = (t: string) => t.startsWith('sk-ant-oat') && t.length > 20 && !t.includes(' ')
        const isValidApiKey = (k: string) => k !== 'placeholder' && k.length > 10 && !k.includes(' ')

        if (providerKey === 'anthropic') {
            if (oauthToken && isValidOAuthToken(oauthToken)) {
                logger.info({ workspaceId, providerKey }, 'ai-cred: ✓ anthropic OAuth token found')
                return withPrimary('anthropic', { type: 'api_key', apiKey: oauthToken })
            }
            if (apiKey && isValidApiKey(apiKey)) {
                logger.info({ workspaceId, providerKey }, 'ai-cred: ✓ anthropic API key found')
                return withPrimary('anthropic', { type: 'api_key', apiKey })
            }
            logger.debug({ workspaceId, providerKey, status, hasOAuth: !!oauthToken, hasKey: !!apiKey }, 'ai-cred: anthropic — no valid key/token, skip')
        } else {
            if (apiKey && isValidApiKey(apiKey)) {
                logger.info({ workspaceId, providerKey }, 'ai-cred: ✓ API key found')
                return withPrimary(providerKey, { type: 'api_key', apiKey })
            }
            if (status === 'configured' || baseUrl) {
                logger.info({ workspaceId, providerKey, baseUrl }, 'ai-cred: ✓ keyless provider (configured/baseUrl)')
                return withPrimary(providerKey, { type: 'api_key', apiKey: 'local' })
            }
            logger.debug({ workspaceId, providerKey, status, hasApiKey: !!apiKey }, 'ai-cred: no usable credential, skip')
        }
    }

    // 3. Installed OAuth token from the OAuth flow (fallback for anthropic)
    try {
        const tokens = await getAnthropicTokens(workspaceId)
        if (tokens?.accessToken) {
            logger.info({ workspaceId }, 'ai-cred: ✓ installed Anthropic OAuth token found')
            return withPrimary('anthropic', { type: 'api_key', apiKey: tokens.accessToken })
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'ai-cred: getAnthropicTokens failed')
    }

    logger.warn({ workspaceId, chain }, 'ai-cred: ✗ no usable credential found in any provider — task will be blocked')
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
