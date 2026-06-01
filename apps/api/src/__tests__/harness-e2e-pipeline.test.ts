// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase B — E2E pipeline integration test
 *
 * Exercises the full dispatch → context assembly → execution-config pipeline.
 * Uses real cron-dispatch.ts with mocked DB and queue deps.
 *
 * Asserts end-to-end:
 *   1. cron-dispatch reads harness fields from DB and pushes correct context
 *   2. notifyChannel → channel + chatId split (Telegram delivery path)
 *   3. repoUrl + branchRef in context (executor would clone this)
 *   4. connectorIds forwarded when set on routine
 *   5. agent-loop fail-closed: cron source + no connectorIds → deny-all []
 *   6. agent-loop allow-through: cron source + connectorIds populated → uses allowlist
 *   7. Telegram delivery fires when channel+chatId are present in context
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const WS_ID  = 'aaaaaaaa-0000-0000-0000-000000000001'
const JOB_ID = 'bbbbbbbb-0000-0000-0000-000000000002'
const CONN_A = 'cccccccc-0000-0000-0000-000000000003'
const TASK_ID = 'task_dddddddd'

type PushArgs = { workspaceId: string; type: string; source: string; context: Record<string, unknown> }

const ctl = {
    dueJobs: [] as Record<string, unknown>[],
    pushCalls: [] as PushArgs[],
}

vi.mock('@plexo/db', () => {
    const execute = vi.fn(async () => ctl.dueJobs)
    const updateWhere = vi.fn(() => ({ catch: () => Promise.resolve() }))
    const updateSet = vi.fn((set: Record<string, unknown>) => ({
        where: (_w: unknown) => { return { catch: () => Promise.resolve() } },
    }))
    const update = vi.fn(() => ({ set: updateSet }))
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
    push: vi.fn(async (args: PushArgs) => { ctl.pushCalls.push(args); return TASK_ID }),
}))

vi.mock('../channel-delivery.js', () => ({
    deliverToOriginChannel: vi.fn(async () => {}),
}))

vi.mock('../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

function makeJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: JOB_ID,
        name: 'Nightly PR sweep',
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
        repoUrl: null, repo_url: null,
        branchRef: 'main', branch_ref: 'main',
        connectorIds: [], connector_ids: [],
        notifyChannel: null, notify_channel: null,
        ...overrides,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1: full dispatch pipeline (cron-dispatch.ts exercises)
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E pipeline — cron-dispatch → queue context', () => {
    beforeEach(() => {
        ctl.dueJobs = []
        ctl.pushCalls = []
        vi.resetModules()
    })

    it('complete harness context: repo clone + Telegram notify + connector scope', async () => {
        ctl.dueJobs = [makeJob({
            prompt: 'Sweep open PRs older than 7 days.',
            repoUrl: 'joeybuilt/plexo',
            repo_url: 'joeybuilt/plexo',
            branchRef: 'main', branch_ref: 'main',
            connectorIds: [CONN_A], connector_ids: [CONN_A],
            notifyChannel: 'telegram:111222333',
            notify_channel: 'telegram:111222333',
        })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()

        const ctx = ctl.pushCalls[0]!.context

        // Dispatch fires
        expect(ctl.pushCalls).toHaveLength(1)
        expect(ctl.pushCalls[0]!.source).toBe('cron')
        expect(ctl.pushCalls[0]!.workspaceId).toBe(WS_ID)

        // Repo clone context
        expect(ctx.repoUrl).toBe('joeybuilt/plexo')
        expect(ctx.branchRef).toBe('main')

        // Telegram notify path
        expect(ctx.notifyChannel).toBe('telegram:111222333')
        expect(ctx.channel).toBe('telegram')
        expect(ctx.chatId).toBe('111222333')

        // Connector allowlist forwarded
        expect(ctx.connectorIds).toEqual([CONN_A])

        // Routine link (for outcome capture)
        expect(ctx.cronJobId).toBe(JOB_ID)

        // Prompt forwarded as userMessage
        expect(ctx.userMessage).toBe('Sweep open PRs older than 7 days.')
    })

    it('repo context absent when repoUrl is null → executor will not clone', async () => {
        ctl.dueJobs = [makeJob()]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const ctx = ctl.pushCalls[0]!.context
        expect(ctx.repoUrl).toBeUndefined()
        expect(ctx.branchRef).toBeUndefined()
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2: agent-loop fail-closed scoping (simulates context construction)
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E pipeline — agent-loop fail-closed gate', () => {
    const AUTOMATED = new Set(['cron', 'github'])

    function resolveConnectorIds(ctx: Record<string, unknown>, source: string): string[] | undefined {
        const ids = ctx.connectorIds
        const fromContext = Array.isArray(ids) && ids.length > 0 ? ids as string[] : undefined
        if (fromContext === undefined && AUTOMATED.has(source)) return []
        return fromContext
    }

    it('cron task with connectorIds in context → allowlist passes through', () => {
        const ctx = { connectorIds: [CONN_A] }
        expect(resolveConnectorIds(ctx, 'cron')).toEqual([CONN_A])
    })

    it('cron task with no connectorIds → deny-all [] (fail-closed)', () => {
        expect(resolveConnectorIds({}, 'cron')).toEqual([])
    })

    it('user task with no connectorIds → undefined (allow-all)', () => {
        expect(resolveConnectorIds({}, 'user')).toBeUndefined()
    })

    it('github PR critic task with connectorIds → allowlist passes (critic can act)', () => {
        const ctx = { connectorIds: [CONN_A], githubEvent: 'pull_request', action: 'opened' }
        expect(resolveConnectorIds(ctx, 'github')).toEqual([CONN_A])
    })

    it('github task with no connectorIds → deny-all (non-critic webhook events cant use connectors)', () => {
        const ctx = { githubEvent: 'push' }
        expect(resolveConnectorIds(ctx, 'github')).toEqual([])
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3: Telegram delivery path — channel+chatId presence triggers delivery
// ─────────────────────────────────────────────────────────────────────────────

describe('E2E pipeline — Telegram delivery gate', () => {
    beforeEach(() => {
        ctl.dueJobs = []
        ctl.pushCalls = []
        vi.resetModules()
    })

    function shouldDeliver(ctx: Record<string, unknown>): boolean {
        return !!(ctx.channel && ctx.chatId)
    }

    it('notifyChannel=telegram:123 → channel+chatId present → delivery fires', async () => {
        ctl.dueJobs = [makeJob({ notifyChannel: 'telegram:123456789', notify_channel: 'telegram:123456789' })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const ctx = ctl.pushCalls[0]!.context
        expect(shouldDeliver(ctx)).toBe(true)
        expect(ctx.channel).toBe('telegram')
        expect(ctx.chatId).toBe('123456789')
    })

    it('no notifyChannel → no channel/chatId → delivery does not fire', async () => {
        ctl.dueJobs = [makeJob()]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const ctx = ctl.pushCalls[0]!.context
        expect(shouldDeliver(ctx)).toBe(false)
    })
})
