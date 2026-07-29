// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Harness integration — cron-dispatch context assembly
 *
 * Verifies that the 5 new harness fields (prompt/repoUrl/branchRef/connectorIds/notifyChannel)
 * are correctly forwarded into the task context when a routine fires. Also covers the
 * notifyChannel → channel + chatId split (Telegram notify path).
 *
 * Modelled after cron-dispatch-reminders.test.ts — @plexo/db is fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const WS_ID  = 'aaaaaaaa-0000-0000-0000-000000000001'
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000002'
const CONN_A = 'cccccccc-0000-0000-0000-000000000003'
const CONN_B = 'dddddddd-0000-0000-0000-000000000004'

type PushArgs = { workspaceId: string; type: string; source: string; context: Record<string, unknown> }

const ctl = {
    dueJobs: [] as Record<string, unknown>[],
    pushCalls: [] as PushArgs[],
    updates: [] as Record<string, unknown>[],
}

vi.mock('@plexo/db', () => {
    const execute = vi.fn(async () => ctl.dueJobs)

    const updateWhere = vi.fn((_w: unknown) => ({ catch: (_fn: unknown) => Promise.resolve() }))
    const updateSet = vi.fn((set: Record<string, unknown>) => ({
        where: (_w: unknown) => { ctl.updates.push(set); return { catch: () => Promise.resolve() } },
    }))
    const update = vi.fn(() => ({ set: updateSet }))

    // channels lookup (for reminder-type jobs — unused in these tests but must exist)
    const limit = vi.fn(async () => [] as unknown[])
    const whereSel = vi.fn(() => ({ limit }))
    const fromSel = vi.fn(() => ({ where: whereSel }))
    const select = vi.fn(() => ({ from: fromSel }))

    return {
        db: { execute, select, update },
        cronJobs: { id: 'id', enabled: 'enabled', nextRunAt: 'next_run_at', workspaceId: 'workspace_id' } as any,
        channels: { id: 'id', workspaceId: 'workspace_id', type: 'type', enabled: 'enabled' } as any,
        eq: vi.fn(() => ({})),
        and: vi.fn(() => ({})),
        or: vi.fn(() => ({})),
        lte: vi.fn(() => ({})),
        isNull: vi.fn(() => ({})),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async (args: PushArgs) => { ctl.pushCalls.push(args); return 'task-123' }),
}))

vi.mock('../channel-delivery.js', () => ({
    deliverToOriginChannel: vi.fn(async () => {}),
}))

vi.mock('../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// ── Fixture ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: JOB_ID,
        name: 'Test routine',
        workspaceId: WS_ID,
        workspace_id: WS_ID,
        taskType: 'general',
        task_type: 'general',
        taskContext: {},
        task_context: {},
        schedule: '0 9 * * 1-5',
        next_run_at: new Date(Date.now() - 1000),
        nextRunAt: new Date(Date.now() - 1000),
        consecutiveFailures: 0,
        consecutive_failures: 0,
        enabled: true,
        prompt: null,
        repoUrl: null,
        repo_url: null,
        branchRef: 'main',
        branch_ref: 'main',
        connectorIds: [],
        connector_ids: [],
        notifyChannel: null,
        notify_channel: null,
        ...overrides,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('cron-dispatch — harness fields in task context', () => {
    beforeEach(() => {
        ctl.dueJobs = []
        ctl.pushCalls = []
        ctl.updates = []
        vi.resetModules()
    })

    it('forwards prompt as userMessage', async () => {
        ctl.dueJobs = [makeJob({ prompt: 'Summarise open PRs.' })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls).toHaveLength(1)
        expect(ctl.pushCalls[0]!.context.userMessage).toBe('Summarise open PRs.')
    })

    it('forwards repoUrl + branchRef when repoUrl is set', async () => {
        ctl.dueJobs = [makeJob({ repoUrl: 'joeybuilt/plexo', repo_url: 'joeybuilt/plexo', branchRef: 'develop', branch_ref: 'develop' })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls[0]!.context.repoUrl).toBe('joeybuilt/plexo')
        expect(ctl.pushCalls[0]!.context.branchRef).toBe('develop')
    })

    it('omits repo fields when repoUrl is null', async () => {
        ctl.dueJobs = [makeJob()]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls[0]!.context.repoUrl).toBeUndefined()
        expect(ctl.pushCalls[0]!.context.branchRef).toBeUndefined()
    })

    it('forwards connectorIds when non-empty', async () => {
        ctl.dueJobs = [makeJob({ connectorIds: [CONN_A, CONN_B], connector_ids: [CONN_A, CONN_B] })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls[0]!.context.connectorIds).toEqual([CONN_A, CONN_B])
    })

    it('omits connectorIds from context when empty array', async () => {
        ctl.dueJobs = [makeJob()]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls[0]!.context.connectorIds).toBeUndefined()
    })

    it('notifyChannel telegram:<chatId> → channel + chatId in context', async () => {
        ctl.dueJobs = [makeJob({ notifyChannel: 'telegram:987654321', notify_channel: 'telegram:987654321' })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const ctx = ctl.pushCalls[0]!.context
        expect(ctx.notifyChannel).toBe('telegram:987654321')
        expect(ctx.channel).toBe('telegram')
        expect(ctx.chatId).toBe('987654321')
    })

    it('notifyChannel without chatId → no channel/chatId in context', async () => {
        ctl.dueJobs = [makeJob({ notifyChannel: 'telegram', notify_channel: 'telegram' })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const ctx = ctl.pushCalls[0]!.context
        expect(ctx.notifyChannel).toBe('telegram')
        expect(ctx.channel).toBeUndefined()
        expect(ctx.chatId).toBeUndefined()
    })

    it('all harness fields together → full context', async () => {
        ctl.dueJobs = [makeJob({
            prompt: 'Daily PR sweep.',
            repoUrl: 'joeybuilt/plexo',
            repo_url: 'joeybuilt/plexo',
            branchRef: 'main',
            branch_ref: 'main',
            connectorIds: [CONN_A],
            connector_ids: [CONN_A],
            notifyChannel: 'telegram:111222333',
            notify_channel: 'telegram:111222333',
        })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const call = ctl.pushCalls[0]!
        expect(call.source).toBe('cron')
        const ctx = call.context
        expect(ctx.userMessage).toBe('Daily PR sweep.')
        expect(ctx.repoUrl).toBe('joeybuilt/plexo')
        expect(ctx.branchRef).toBe('main')
        expect(ctx.connectorIds).toEqual([CONN_A])
        expect(ctx.channel).toBe('telegram')
        expect(ctx.chatId).toBe('111222333')
        expect(ctx.cronJobId).toBe(JOB_ID)
    })

    it('source is always cron (not github or user)', async () => {
        ctl.dueJobs = [makeJob()]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls[0]!.source).toBe('cron')
    })
})
