// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase E — Loop E2E
 *
 * Exercises the full agent-loop path from task dequeue to completion:
 *   buildTaskContext (exported as processTaskForTesting)
 *     → git clone (node:child_process exec stubbed)
 *     → executeTask (executor stubbed → returns complete)
 *     → deliverToOriginChannel (Telegram stub → channel+chatId asserted)
 *
 * All heavy deps are mocked. The test exercises real production code in
 * agent-loop.ts, not just the context assembly pipeline.
 *
 * Assertions:
 *   A. sprintWorkDir set: exec called with 'git clone ... <repo>.git .'
 *   B. executor reached complete: executeTask called + returned complete payload
 *   C. Telegram stub called with channel='telegram', chatId from notifyChannel
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Constants ─────────────────────────────────────────────────────────────────

const WS_ID    = 'aaaaaaaa-0000-0000-0000-000000000001'
const TASK_ID  = 'task_bbbbbbbbbbbbbbbbbbbb'
const REPO     = 'joeybuilt/plexo'
const BRANCH   = 'main'
const CHAT_ID  = '987654321'
const WORK_DIR = '/tmp/plexo-sprint-test123'

// Shared capture containers
const captured = {
    execCalls:    [] as string[],
    deliverCalls: [] as Record<string, unknown>[],
    executorCalls: 0,
}

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => {
    // All DB calls return safe empty/no-op responses so no gate blocks execution.
    const noop = vi.fn(async () => [])
    const chainable = {
        from: vi.fn(() => chainable),
        where: vi.fn(() => chainable),
        limit: vi.fn(async () => []),
        set: vi.fn(() => chainable),
        values: vi.fn(() => chainable),
        returning: vi.fn(async () => [{ id: TASK_ID }]),
        catch: vi.fn(() => Promise.resolve()),
        then: vi.fn((fn: Function) => { fn([]); return Promise.resolve([]) }),
    }
    const select = vi.fn(() => chainable)
    const update = vi.fn(() => chainable)
    const insert = vi.fn(() => chainable)
    return {
        db: { select, update, insert, execute: noop },
        tasks: { id: 'id', workspaceId: 'workspace_id', type: 'type', status: 'status', source: 'source', context: 'context', costCeilingUsd: 'cost_ceiling_usd', tokenBudget: 'token_budget', wallClockLimitSec: 'wall_clock_limit_sec', plan: 'plan', attemptCount: 'attempt_count', outcomeSummary: 'outcome_summary', failedAt: 'failed_at', failureReason: 'failure_reason', deliverable: 'deliverable', completedAt: 'completed_at', claimedAt: 'claimed_at', parentId: 'parent_id', projectId: 'project_id' } as any,
        taskSteps: { taskId: 'task_id', stepNumber: 'step_number', state: 'state', stepType: 'step_type', stepSpec: 'step_spec', outcome: 'outcome' } as any,
        apiCostTracking: { workspaceId: 'workspace_id', weekStart: 'week_start', costUsd: 'cost_usd', ceilingUsd: 'ceiling_usd' } as any,
        workspaces: { id: 'id', settings: 'settings', intelligenceSettings: 'intelligence_settings', name: 'name', persona: 'persona', defaultCostCeilingUsd: 'default_cost_ceiling_usd' } as any,
        sprints: { id: 'id' } as any,
        sprintTasks: { taskId: 'task_id', sprintId: 'sprint_id', status: 'status' } as any,
        plexoOpsTaskEvents: { taskId: 'task_id', workspaceId: 'workspace_id', eventType: 'event_type', fromState: 'from_state', toState: 'to_state', metadata: 'metadata', ts: 'ts' } as any,
        installedConnections: { id: 'id', workspaceId: 'workspace_id', registryId: 'registry_id', status: 'status' } as any,
        eq: vi.fn(() => ({})),
        and: vi.fn(() => ({})),
        sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v }), { join: vi.fn() }),
        inArray: vi.fn(() => ({})),
        desc: vi.fn(() => ({})),
        lte: vi.fn(() => ({})),
        isNull: vi.fn(() => ({})),
        gte: vi.fn(() => ({})),
    }
})

vi.mock('@plexo/queue', () => ({
    claimTask: vi.fn(async () => null),
    completeTask: vi.fn(async () => {}),
    blockTask: vi.fn(async () => {}),
    requeueForRetry: vi.fn(async () => 'failed'),
    push: vi.fn(async () => TASK_ID),
}))

vi.mock('@plexo/agent/executor', () => ({
    executeTask: vi.fn(async () => {
        captured.executorCalls++
        return {
            status: 'complete',
            outcomeSummary: 'Swept open PRs. Found 3, commented on 2.',
            qualityScore: 0.85,
            totalCostUsd: 0.0012,
            activeProvider: 'anthropic',
            error: null,
        }
    }),
}))

vi.mock('@plexo/agent/planner', () => ({
    planTask: vi.fn(async () => ({
        type: 'plan',
        plan: {
            taskId: TASK_ID,
            goal: 'Run task',
            steps: [{ stepNumber: 1, description: 'Run task', toolsRequired: [], verificationMethod: 'Review output', isOneWayDoor: false }],
            oneWayDoors: [],
            estimatedDurationMs: 30000,
            confidenceScore: 0.9,
            risks: [],
        },
    })),
}))

vi.mock('@plexo/agent/tasks/terminal-fail', () => ({
    markTaskFailed: vi.fn(async () => ({ summary: { text: 'failed' } })),
    FailureReason: { ToolError: 'tool_error', CostCeilingExceeded: 'cost_ceiling', MaxAttemptsExceeded: 'max_attempts' },
}))

vi.mock('@plexo/agent/tasks/types', () => ({
    FailureReason: { ToolError: 'tool_error', CostCeilingExceeded: 'cost_ceiling', MaxAttemptsExceeded: 'max_attempts' },
}))

vi.mock('@plexo/agent/event-bus', () => ({
    eventBus: { on: vi.fn(), emit: vi.fn(), off: vi.fn() },
    TOPICS: { OWD_RESOLVED: 'owd_resolved' },
}))

vi.mock('@plexo/agent/behavior/reflect', () => ({
    reflectAndPromote: vi.fn(async () => {}),
}))

vi.mock('@plexo/agent/memory/store', () => ({
    storeMemory: vi.fn(async () => ({ id: 'mem-1' })),
}))

vi.mock('@plexo/agent/one-way-door', () => ({
    requestApproval: vi.fn(async () => 'approved'),
    waitForDecision: vi.fn(async () => ({ decision: 'approve' })),
    getDecision: vi.fn(() => null),
    elevateOutboundOneWayDoors: vi.fn(() => ({ oneWayDoors: [], addedTools: [] })),
}))

vi.mock('@plexo/agent/sprint/sprint-ledger', () => ({
    logSprintHandoff: vi.fn(async () => {}),
}))

vi.mock('@plexo/agent/github/client', () => ({
    resolveGitHubToken: vi.fn(async () => 'ghp_test_token'),
}))

vi.mock('@plexo/agent/cost-gate', () => ({
    recordSpend: vi.fn(async () => {}),
}))

vi.mock('../sse-emitter.js', () => ({
    emitToWorkspace: vi.fn(),
}))

vi.mock('../channel-delivery.js', () => ({
    channelSupportsConfirmation: vi.fn(() => false),
    deliverToOriginChannel: vi.fn(async (args: Record<string, unknown>) => {
        captured.deliverCalls.push(args)
    }),
    startTaskProgressUpdates: vi.fn(() => () => {}),
    deliverTaskTransition: vi.fn(async () => {}),
}))

vi.mock('../routes/code.js', () => ({
    registerCodeContext: vi.fn(),
    unregisterCodeContext: vi.fn(),
}))

vi.mock('../analytics/events.js', () => ({
    emitAgentRunStarted: vi.fn(),
    emitTaskOutcome: vi.fn(),
    emitReflectionEvent: vi.fn(),
    emitInferenceInvoked: vi.fn(),
    emitOnboardingCompleted: vi.fn(),
    deliverTaskTransition: vi.fn(async () => {}),
}))

vi.mock('../event-tracker.js', () => ({
    trackError: vi.fn(),
    trackEvent: vi.fn(),
}))

vi.mock('../lib/intelligence-cache.js', () => ({
    getCachedIntelligenceSettings: vi.fn(async (_wsId: string, loader: () => Promise<unknown>) => {
        return { costCeilingMode: 'off' }
    }),
}))

vi.mock('../lib/metrics.js', () => ({
    incrementCounter: vi.fn(),
}))

vi.mock('../parallel-executor.js', () => ({
    claimBatch: vi.fn(async () => []),
    releaseSlot: vi.fn(async () => {}),
    extendSlot: vi.fn(async () => {}),
    claimSlot: vi.fn(async () => true),
    HEARTBEAT_INTERVAL_MS: 30_000,
    OWD_RELEASE_SLOT: false,
}))

vi.mock('../routes/ai-provider-creds.js', () => ({
    loadDecryptedAIProviders: vi.fn(async () => [{
        provider: 'anthropic',
        credential: { api_key: 'sk-test-key' },
        model: 'claude-sonnet-4-6',
    }]),
}))

vi.mock('../routes/introspect.js', () => ({
    invalidateIntrospectCache: vi.fn(async () => {}),
    introspectCacheKey: vi.fn((id: string) => `plexo:introspect:${id}`),
    introspectRouter: { get: vi.fn() },
}))

vi.mock('@plexo/agent/introspection', () => ({
    buildIntrospectionSnapshot: vi.fn(async () => ({})),
    toConversationSnapshot: vi.fn(() => ''),
}))

vi.mock('../routes/search.js', () => ({
    getDecryptedBraveKey: vi.fn(async () => null),
}))

vi.mock('../conversation-log.js', () => ({
    updateConversationForTask: vi.fn(async () => {}),
}))

vi.mock('../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}))

vi.mock('../outcome-capture.js', () => ({
    recordOutcome: vi.fn(async () => {}),
    recordHumanVerdict: vi.fn(async () => {}),
    buildOutcomePayload: vi.fn((opts: Record<string, unknown>) => opts),
}))

// Mock node:child_process exec to capture git clone and return success
vi.mock('node:child_process', () => ({
    exec: vi.fn((_cmd: string, _opts: unknown, callback: (err: null, stdout: string, stderr: string) => void) => {
        captured.execCalls.push(_cmd)
        if (callback) callback(null, '', '')
        return { pid: 1234 }
    }),
}))

vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
        ...actual,
        mkdtempSync: vi.fn(() => WORK_DIR),
        mkdirSync: vi.fn(),
        readdirSync: vi.fn(() => []),
        rmSync: vi.fn(),
        promises: {
            ...actual.promises,
            readdir: vi.fn(async () => []),
            readFile: vi.fn(async () => ''),
        },
    }
})

vi.mock('@plexo/agent/providers/settings-from-instances', () => ({
    loadSettingsFromInstances: vi.fn(async () => ({
        primaryProvider: 'anthropic',
        fallbackChain: [],
        inferenceMode: 'auto',
        providers: {
            anthropic: {
                provider: 'anthropic',
                apiKey: 'sk-ant-FAKEFAKEFAKEFAKEFAKE00',
                baseUrl: undefined,
                status: 'configured',
                model: 'claude-sonnet-4-6',
                enabled: true,
            },
        },
    })),
}))

// ── Test ──────────────────────────────────────────────────────────────────────

describe('Phase E — loop E2E: dispatch → clone → execute → notify', () => {
    beforeEach(() => {
        captured.execCalls = []
        captured.deliverCalls = []
        captured.executorCalls = 0
        vi.clearAllMocks()
        vi.resetModules()
    })

    it('full loop: repo cloned + executor complete + Telegram stub called with channel+chatId', async () => {
        // Task built as cron-dispatch would push it:
        // source='cron', context has repoUrl+branchRef+notifyChannel→channel+chatId+connectorIds
        const task = {
            id: TASK_ID,
            workspaceId: WS_ID,
            workspace_id: WS_ID,
            type: 'general',
            status: 'claimed',
            source: 'cron',
            priority: 1,
            project: null,
            projectId: null,
            parentId: null,
            qualityScore: null,
            confidenceScore: null,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
            costCeilingUsd: null,
            tokenBudget: null,
            promptVersion: null,
            outcomeSummary: null,
            attemptCount: 0,
            deliverable: null,
            plan: null,
            wallClockLimitSec: null,
            failedAt: null,
            failureReason: null,
            claimedAt: new Date(),
            completedAt: null,
            createdAt: new Date(),
            context: {
                userMessage: 'Sweep open PRs older than 7 days.',
                repoUrl: REPO,
                branchRef: BRANCH,
                // notifyChannel was split by cron-dispatch:
                channel: 'telegram',
                chatId: CHAT_ID,
                notifyChannel: `telegram:${CHAT_ID}`,
                connectorIds: [],   // fail-closed (no allowlist on this routine)
                cronJobId: 'cron-job-uuid',
            },
        } as any

        // Re-import with fresh mocks after resetModules
        const { executeTask } = await import('@plexo/agent/executor')
        const { deliverToOriginChannel } = await import('../channel-delivery.js')
        const { exec } = await import('node:child_process')
        const { mkdtempSync } = await import('node:fs')

        // Wire exec mock to capture calls
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(vi.mocked(exec) as any).mockImplementation((_cmd: string, _opts: unknown, cb: ((err: null, out: string, err2: string) => void) | undefined) => {
            captured.execCalls.push(_cmd)
            if (typeof _opts === 'function') (_opts as unknown as (e: null, o: string, s: string) => void)(null, '', '')
            else if (cb) cb(null, '', '')
            return { pid: 1234 }
        })
        vi.mocked(mkdtempSync).mockReturnValue(WORK_DIR)

        const deliverMock = vi.mocked(deliverToOriginChannel)
        deliverMock.mockImplementation(async (args) => {
            captured.deliverCalls.push((args as unknown) as Record<string, unknown>)
        })

        const executorMock = vi.mocked(executeTask)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(executorMock as any).mockImplementation(async () => {
            captured.executorCalls++
            return {
                taskId: TASK_ID,
                ok: true,
                status: 'complete',
                outcomeSummary: 'Swept open PRs. Found 3, commented on 2.',
                qualityScore: 0.85,
                totalCostUsd: 0.0012,
                totalTokensIn: 0,
                totalTokensOut: 0,
                totalDurationMs: 100,
                steps: [],
                activeProvider: 'anthropic',
                error: null,
            }
        })

        const { processTaskForTesting } = await import('../agent-loop.js')
        const { logger } = await import('../logger.js')
        await processTaskForTesting(task)


        // ── Assertion A: repo cloned ──────────────────────────────────────────
        // sprintWorkDir is set when exec runs git clone successfully.
        const cloneCall = captured.execCalls.find(c => c.includes('git clone'))
        expect(cloneCall, 'git clone must have been called').toBeTruthy()
        expect(cloneCall).toContain(REPO)
        expect(cloneCall).toContain(BRANCH)
        expect(vi.mocked(mkdtempSync)).toHaveBeenCalled()

        // ── Assertion B: executor reached complete ────────────────────────────
        expect(captured.executorCalls, 'executeTask must be called once').toBe(1)
        expect(executorMock).toHaveBeenCalledOnce()

        // ── Assertion C: Telegram stub called with channel+chatId ─────────────
        expect(captured.deliverCalls.length, 'deliverToOriginChannel must be called').toBeGreaterThan(0)
        const deliver = captured.deliverCalls[0]!
        const ctx = deliver.context as Record<string, unknown>
        expect(ctx.channel).toBe('telegram')
        expect(ctx.chatId).toBe(CHAT_ID)
        expect(deliver.outcome).toBe('complete')
    })
})
