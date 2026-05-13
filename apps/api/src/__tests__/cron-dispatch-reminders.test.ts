// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase L4 Stage 2 — cron-dispatch one-shot semantics + reminder routing.
 *
 * Covers:
 *   - Recurring fire → nextRunAt advances, enabled stays true.
 *   - One-shot fire (schedule===null) → enabled=false, nextRunAt=null.
 *   - Reminder routing (taskType==='reminder') → deliverToOriginChannel called,
 *     queue.push not called.
 *   - Reminder with no taskContext.channel → warn logged, no crash.
 *   - Reminder where deliverToOriginChannel throws → consecutive_failures bumped,
 *     loop continues.
 *
 * The full @plexo/db / @plexo/queue / channel-delivery surfaces are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface MockJobRow {
    id: string
    name: string
    workspaceId: string
    taskType: string
    taskContext: Record<string, unknown>
    schedule: string | null
    consecutiveFailures: number
    enabled: boolean
}

const ctl = {
    dueJobs: [] as MockJobRow[],
    enabledChannels: [] as { id: string }[],
    deliverThrows: false as boolean | string,
    pushThrows: false as boolean,
    updates: [] as { id: string; set: Record<string, unknown> }[],
    pushCalls: [] as Array<{ workspaceId: string; type: string; context: unknown }>,
    deliverCalls: [] as Array<Record<string, unknown>>,
    warns: [] as unknown[][],
    errors: [] as unknown[][],
    infos: [] as unknown[][],
}

vi.mock('@plexo/db', () => {
    const execute = vi.fn(async () => ctl.dueJobs)

    // db.select() chain returns the channels lookup — we toggle results via ctl.enabledChannels.
    const limit = vi.fn(async () => ctl.enabledChannels)
    const whereSel = vi.fn(() => ({ limit }))
    const fromSel = vi.fn(() => ({ where: whereSel }))
    const select = vi.fn(() => ({ from: fromSel }))

    // db.update() chain captures sets.
    const updateWhere = vi.fn(() => ({
        catch: (_fn: unknown) => Promise.resolve(),
    }))
    const updateSet = vi.fn((set: Record<string, unknown>) => {
        // Capture set against the next .where() call by stashing it on the chain.
        ;(updateWhere as any).__lastSet = set
        return { where: (_w: unknown) => {
            ctl.updates.push({ id: '__pending__', set })
            return { catch: (_fn: unknown) => Promise.resolve() }
        } }
    })
    const update = vi.fn((_t: unknown) => ({ set: updateSet }))

    return {
        db: { execute, select, update },
        cronJobs: { id: 'id', enabled: 'enabled', nextRunAt: 'next_run_at' } as any,
        channels: { id: 'id', workspaceId: 'workspace_id', type: 'type', enabled: 'enabled' } as any,
        eq: vi.fn((..._a: unknown[]) => ({})),
        and: vi.fn((..._a: unknown[]) => ({})),
        or: vi.fn(),
        lte: vi.fn(),
        isNull: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async (args: { workspaceId: string; type: string; context: unknown }) => {
        ctl.pushCalls.push(args)
        if (ctl.pushThrows) throw new Error('queue offline')
        return 'task-id'
    }),
}))

vi.mock('../channel-delivery.js', () => ({
    deliverToOriginChannel: vi.fn(async (payload: Record<string, unknown>) => {
        ctl.deliverCalls.push(payload)
        if (ctl.deliverThrows) throw new Error(typeof ctl.deliverThrows === 'string' ? ctl.deliverThrows : 'gmail down')
    }),
}))

vi.mock('../logger.js', () => ({
    logger: {
        info: vi.fn((...a: unknown[]) => ctl.infos.push(a)),
        warn: vi.fn((...a: unknown[]) => ctl.warns.push(a)),
        error: vi.fn((...a: unknown[]) => ctl.errors.push(a)),
        debug: vi.fn(),
    },
}))

describe('dispatchDueJobs — one-shot + reminder routing', () => {
    beforeEach(() => {
        ctl.dueJobs = []
        ctl.enabledChannels = [{ id: 'ch-1' }]
        ctl.deliverThrows = false
        ctl.pushThrows = false
        ctl.updates = []
        ctl.pushCalls = []
        ctl.deliverCalls = []
        ctl.warns = []
        ctl.errors = []
        ctl.infos = []
    })

    function jobOf(o: Partial<MockJobRow>): MockJobRow {
        return {
            id: o.id ?? 'job-1',
            name: o.name ?? 'Test job',
            workspaceId: o.workspaceId ?? 'ws-1',
            taskType: o.taskType ?? 'general',
            taskContext: o.taskContext ?? {},
            schedule: o.schedule === undefined ? '0 9 * * *' : o.schedule,
            consecutiveFailures: o.consecutiveFailures ?? 0,
            enabled: o.enabled ?? true,
        }
    }

    it('recurring success → nextRunAt advances; enabled untouched', async () => {
        ctl.dueJobs = [jobOf({ schedule: '0 9 * * *' })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls).toHaveLength(1)
        const [u] = ctl.updates
        expect(u).toBeDefined()
        expect(u!.set.lastRunStatus).toBe('success')
        expect(u!.set.consecutiveFailures).toBe(0)
        expect(u!.set.nextRunAt).toBeInstanceOf(Date)
        // recurring success path leaves `enabled` unset
        expect(u!.set).not.toHaveProperty('enabled')
    })

    it('one-shot success (schedule===null) → enabled=false, nextRunAt=null', async () => {
        ctl.dueJobs = [jobOf({ schedule: null })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls).toHaveLength(1)
        const [u] = ctl.updates
        expect(u!.set.enabled).toBe(false)
        expect(u!.set.nextRunAt).toBeNull()
        expect(u!.set.lastRunStatus).toBe('success')
    })

    it('reminder job with channel=gmail → deliverToOriginChannel called, queue.push NOT called', async () => {
        ctl.dueJobs = [jobOf({
            taskType: 'reminder',
            schedule: null,
            taskContext: {
                channel: 'gmail',
                chatId: 'user@example.com',
                message: 'time to ship',
                channelId: 'gmail-ch-1',
                from: 'user@example.com',
            },
        })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.pushCalls).toHaveLength(0)
        expect(ctl.deliverCalls).toHaveLength(1)
        const payload = ctl.deliverCalls[0]!
        expect(payload).toMatchObject({
            workspaceId: 'ws-1',
            outcome: 'complete',
            summary: 'time to ship',
        })
        expect((payload.context as Record<string, unknown>).channel).toBe('gmail')
        // one-shot reminder — should still finalize: enabled=false, nextRunAt=null
        const [u] = ctl.updates
        expect(u!.set.enabled).toBe(false)
        expect(u!.set.nextRunAt).toBeNull()
    })

    it('reminder with missing taskContext.channel → warn, no crash, no deliver', async () => {
        ctl.dueJobs = [jobOf({
            taskType: 'reminder',
            schedule: null,
            taskContext: { message: 'hi' }, // no channel
        })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await expect(dispatchDueJobs()).resolves.toBeUndefined()
        expect(ctl.deliverCalls).toHaveLength(0)
        expect(ctl.pushCalls).toHaveLength(0)
        // Warn logged
        const warned = ctl.warns.some(w => /missing channel\/chatId/i.test(String(w[1])))
        expect(warned).toBe(true)
    })

    it('reminder with no enabled channel of that type → warn + skip', async () => {
        ctl.enabledChannels = [] // no enabled channel
        ctl.dueJobs = [jobOf({
            taskType: 'reminder',
            schedule: null,
            taskContext: { channel: 'telegram', chatId: 12345, message: 'hi' },
        })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        expect(ctl.deliverCalls).toHaveLength(0)
        const warned = ctl.warns.some(w => /no enabled channel/i.test(String(w[1])))
        expect(warned).toBe(true)
    })

    it('reminder where deliverToOriginChannel throws → consecutive_failures bumped, loop continues', async () => {
        ctl.deliverThrows = true
        ctl.dueJobs = [
            jobOf({
                id: 'job-r',
                taskType: 'reminder',
                schedule: null,
                consecutiveFailures: 1,
                taskContext: { channel: 'gmail', chatId: 'a@b.com', message: 'x' },
            }),
            // Second job in the same tick — proves the loop continues after the throw.
            jobOf({ id: 'job-2', schedule: '0 9 * * *' }),
        ]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await expect(dispatchDueJobs()).resolves.toBeUndefined()
        // First job's update: failure with consecutiveFailures=2, no enabled toggle, no nextRunAt change.
        expect(ctl.updates[0]!.set.lastRunStatus).toBe('failure')
        expect(ctl.updates[0]!.set.consecutiveFailures).toBe(2)
        expect(ctl.updates[0]!.set).not.toHaveProperty('enabled')
        expect(ctl.updates[0]!.set).not.toHaveProperty('nextRunAt')
        // Second job still ran.
        expect(ctl.pushCalls).toHaveLength(1)
        expect(ctl.updates).toHaveLength(2)
    })

    it('one-shot reminder reaching 3 consecutive failures → enabled=false on 4th tick (bounded retry)', async () => {
        ctl.deliverThrows = true
        ctl.dueJobs = [
            jobOf({
                id: 'job-r',
                taskType: 'reminder',
                schedule: null,
                consecutiveFailures: 2, // this tick will push it to 3
                taskContext: { channel: 'gmail', chatId: 'a@b.com', message: 'x' },
            }),
        ]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const [u] = ctl.updates
        expect(u!.set.lastRunStatus).toBe('failure')
        expect(u!.set.consecutiveFailures).toBe(3)
        expect(u!.set.enabled).toBe(false) // bounded retry — halt the loop
        // nextRunAt left untouched on failure
        expect(u!.set).not.toHaveProperty('nextRunAt')
    })

    it('recurring reminder with 3 consecutive failures → enabled left alone (user-managed)', async () => {
        ctl.deliverThrows = true
        ctl.dueJobs = [
            jobOf({
                id: 'job-rec',
                taskType: 'reminder',
                schedule: '0 9 * * *', // recurring
                consecutiveFailures: 2,
                taskContext: { channel: 'gmail', chatId: 'a@b.com', message: 'x' },
            }),
        ]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const [u] = ctl.updates
        expect(u!.set.lastRunStatus).toBe('failure')
        expect(u!.set.consecutiveFailures).toBe(3)
        expect(u!.set).not.toHaveProperty('enabled')
    })

    it('reminder fired payload context omits the legacy _reminder flag', async () => {
        ctl.dueJobs = [jobOf({
            taskType: 'reminder',
            schedule: null,
            taskContext: { channel: 'gmail', chatId: 'a@b.com', message: 'x' },
        })]
        const { dispatchDueJobs } = await import('../cron-dispatch.js')
        await dispatchDueJobs()
        const payload = ctl.deliverCalls[0]!
        expect((payload.context as Record<string, unknown>)._reminder).toBeUndefined()
    })
})
