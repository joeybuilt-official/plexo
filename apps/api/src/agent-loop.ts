import { claimTask, completeTask, blockTask } from '@plexo/queue'
import { db, eq, sql } from '@plexo/db'
import { tasks, apiCostTracking, workspaces, sprints } from '@plexo/db'
import { planTask } from '@plexo/agent/planner'
import { executeTask } from '@plexo/agent/executor'
import type { AnthropicCredential, ExecutionContext } from '@plexo/agent/types'
import type { WorkspaceAISettings, ProviderKey } from '@plexo/agent/providers/registry'
import { logger } from './logger.js'
import { emit } from './sse-emitter.js'
import { getAnthropicTokens } from './anthropic-tokens.js'
import { loadDecryptedAIProviders } from './routes/ai-provider-creds.js'

const POLL_INTERVAL_MS = 2_000
const API_COST_CEILING = parseFloat(process.env.API_COST_CEILING_USD ?? '10')

let running = true
let activeAbort: AbortController | null = null
let activeTaskId: string | null = null

/**
 * Abort the currently-running task if it matches the given id.
 * Called by DELETE /api/v1/tasks/:id so the executor stops at the
 * next signal-check boundary instead of finishing the current step.
 */
export function cancelActiveTask(taskId: string): boolean {
    if (activeTaskId !== taskId || !activeAbort) return false
    activeAbort.abort()
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

    // claimTask uses raw SQL (RETURNING *) which returns snake_case column names,
    // not camelCase Drizzle mappings. Handle both to be safe.
    const taskWorkspaceId = task.workspaceId
        ?? (task as Record<string, unknown>)['workspace_id'] as string | undefined

    const { credential, aiSettings } = await loadWorkspaceAISettings(taskWorkspaceId ?? '')
    if (!credential) {
        await blockTask(task.id, 'No AI credential configured for workspace')
        emit({ type: 'task_blocked', taskId: task.id, reason: 'No AI credential' })
        logger.warn({ taskId: task.id, workspaceId: taskWorkspaceId }, 'No credential — task blocked')
        return true
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
            emit({ type: 'task_blocked', taskId: task.id, reason: 'WORKSPACE_COST_CEILING' })
            logger.warn({ taskId: task.id, costUsd: costRow.costUsd, ceilingUsd: costRow.ceilingUsd }, 'Workspace ceiling — task blocked')
            return true
        }
    } catch (costErr) {
        logger.warn({ costErr }, 'Pre-flight cost check failed non-fatally — continuing')
    }

    // ── Resolve per-task budget from DB row + workspace defaults ──────────────
    // Priority: task.cost_ceiling_usd → workspace settings default → null (no cap)
    // Priority: task.token_budget → workspace settings default → 0 (no cap)
    const taskRow = await db.select({
        costCeilingUsd: tasks.costCeilingUsd,
        tokenBudget: tasks.tokenBudget,
    }).from(tasks).where(eq(tasks.id, task.id)).limit(1)

    const taskCostCeiling = taskRow[0]?.costCeilingUsd ?? null
    const taskTokenBudget = taskRow[0]?.tokenBudget ?? null

    // Load workspace-level defaults (stored in workspaces.settings.aiProviders)
    let wsDefaultCostCeiling: number | null = null
    let wsDefaultTokenBudget: number | null = null
    try {
        const [wsRow] = await db.select({ settings: workspaces.settings })
            .from(workspaces).where(eq(workspaces.id, taskWorkspaceId ?? '')).limit(1)
        if (wsRow?.settings) {
            const s = wsRow.settings as Record<string, unknown>
            const ap = s.aiProviders as Record<string, unknown> | undefined
            if (ap?.defaultTaskCostCeiling) wsDefaultCostCeiling = Number(ap.defaultTaskCostCeiling) || null
            if (ap?.defaultTokenBudget) wsDefaultTokenBudget = Number(ap.defaultTokenBudget) || null

            // Merge ensemble quality-judge settings into aiSettings if present
            if (aiSettings) {
                const ensembleSize = s.ensembleSize != null ? Number(s.ensembleSize) : undefined
                const dissentThreshold = s.dissentThreshold != null ? Number(s.dissentThreshold) : undefined
                if (ensembleSize != null && !isNaN(ensembleSize)) aiSettings.ensembleSize = ensembleSize
                if (dissentThreshold != null && !isNaN(dissentThreshold)) aiSettings.dissentThreshold = dissentThreshold
            }
        }
    } catch { /* non-fatal */ }

    const resolvedCostCeiling = taskCostCeiling ?? wsDefaultCostCeiling
    const resolvedTokenBudget = taskTokenBudget ?? wsDefaultTokenBudget ?? 0

    // ── Phase A: Load workspace + sprint context for prompt injection ───────────
    let workspaceName: string | undefined
    let workspaceSummary: string | undefined
    let agentName: string | undefined
    let agentPersona: string | undefined
    let sprintGoal: string | undefined
    let sprintName: string | undefined
    // Sprint coding context
    let sprintWorkDir: string | undefined
    let sprintRepo: string | undefined
    let sprintBranch: string | undefined

    try {
        const [wsRow] = await db
            .select({ name: workspaces.name, settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, taskWorkspaceId ?? ''))
            .limit(1)

        if (wsRow) {
            workspaceName = wsRow.name ?? undefined
            const s = (wsRow.settings ?? {}) as Record<string, unknown>
            agentName = typeof s.agentName === 'string' ? s.agentName : workspaceName
            agentPersona = typeof s.agentPersona === 'string' ? s.agentPersona : undefined
            workspaceSummary = typeof s.agentTagline === 'string' ? s.agentTagline : undefined
        }
    } catch { /* non-fatal */ }

    // Load sprint goal if this task belongs to a sprint
    try {
        const taskRowFull = await db
            .select({ projectId: tasks.projectId })
            .from(tasks)
            .where(eq(tasks.id, task.id))
            .limit(1)

        const projectId = taskRowFull[0]?.projectId
        if (projectId) {
            const [sprintRow] = await db
                .select({ request: sprints.request, status: sprints.status })
                .from(sprints)
                .where(eq(sprints.id, projectId))
                .limit(1)
            if (sprintRow) {
                sprintGoal = sprintRow.request ?? undefined
                sprintName = projectId
            }
        }
    } catch { /* non-fatal */ }

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
            } catch (cloneErr) {
                // Non-fatal: executor falls back to process.cwd() which is wrong but at least
                // the task proceeds. The system prompt will tell the agent to clone manually.
                logger.warn({ taskId: task.id, err: cloneErr }, 'Sprint repo clone failed — executor will work without pre-cloned dir')
            }
        }
    }

    const abort = new AbortController()
    activeAbort = abort
    activeTaskId = task.id

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
        // Sprint coding context
        sprintWorkDir,
        sprintRepo,
        sprintBranch,
    }

    try {
        await db.update(tasks)
            .set({ status: 'running', claimedAt: new Date() })
            .where(eq(tasks.id, task.id))

        const taskContext = task.context as Record<string, unknown>
        const description = (taskContext.description as string)
            ?? (taskContext.message as string)
            ?? JSON.stringify(taskContext)

        emit({ type: 'task_planning', taskId: task.id })
        const plannerResult = await planTask(ctx, description, taskContext, aiSettings ?? undefined)

        // Phase D: capability pre-flight — planner returned a clarification request
        if (plannerResult.type === 'clarification') {
            logger.info({ taskId: task.id, alternatives: plannerResult.alternatives.length }, 'Planner returned clarification — capability gap detected')
            await blockTask(task.id, plannerResult.message)
            // Store clarification payload so UI + channels can surface alternatives
            await db.update(tasks).set({
                context: sql`context || ${JSON.stringify({ _clarification: plannerResult })}::jsonb`,
            }).where(eq(tasks.id, task.id))
            emit({
                type: 'task_clarification_needed' as 'task_blocked',
                taskId: task.id,
                reason: plannerResult.message,
            })
            return true
        }

        const plan = plannerResult.plan
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

        // Persist judge metadata into context JSONB so the task detail UI can display it.
        const extResult = result as typeof result & { judgeMeta?: Record<string, unknown> }
        if (extResult.judgeMeta) {
            await db.update(tasks).set({
                context: sql`context || ${JSON.stringify({ _judge: extResult.judgeMeta })}::jsonb`,
            }).where(eq(tasks.id, task.id))
        }

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
        activeTaskId = null
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
