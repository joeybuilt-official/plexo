// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cron route tests — Phase L4 Stage 2.
 *
 * Pins:
 *   - POST accepts schedule XOR scheduleAt (exactly one).
 *   - scheduleAt parsed to nextRunAt; rejects past/>1y/non-ISO-with-tz.
 *   - taskType allow-list includes 'reminder'.
 *   - Reminder requires taskContext.{channel,message}; channel must exist
 *     in the same workspace and be enabled (IDOR guard).
 *   - PATCH from reminder→general drops the channel-existence requirement.
 *   - GET ?type=reminder filters to schedule IS NULL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks (must be hoisted before importing the router) ───────────────────────

const mockSelectImpl = vi.fn()
const mockInsertImpl = vi.fn()
const mockUpdateImpl = vi.fn()
const mockDeleteImpl = vi.fn()

vi.mock('@plexo/db', () => ({
    db: {
        select: (...args: unknown[]) => mockSelectImpl(...args),
        insert: (...args: unknown[]) => mockInsertImpl(...args),
        update: (...args: unknown[]) => mockUpdateImpl(...args),
        delete: (...args: unknown[]) => mockDeleteImpl(...args),
    },
    cronJobs: {
        id: 'cronJobs.id',
        workspaceId: 'cronJobs.workspaceId',
        schedule: 'cronJobs.schedule',
        createdAt: 'cronJobs.createdAt',
    },
    channels: {
        id: 'channels.id',
        workspaceId: 'channels.workspaceId',
        enabled: 'channels.enabled',
        type: 'channels.type',
        config: 'channels.config',
    },
    taskTypeEnum: {
        enumValues: [
            'coding', 'deployment', 'research', 'ops', 'opportunity', 'monitoring',
            'report', 'online', 'automation', 'writing', 'general', 'data',
            'marketing', 'reminder',
        ],
    },
    eq: vi.fn((a, b) => ({ _eq: [a, b] })),
    and: vi.fn((...xs) => ({ _and: xs })),
    desc: vi.fn((c) => ({ _desc: c })),
    isNull: vi.fn((c) => ({ _isNull: c })),
    isNotNull: vi.fn((c) => ({ _isNotNull: c })),
}))

vi.mock('@plexo/queue', () => ({
    push: vi.fn(async () => 'task-id'),
}))

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../event-tracker.js', () => ({
    trackEvent: vi.fn(),
}))

import { cronRouter } from '../cron.js'

// ── Test fixtures ─────────────────────────────────────────────────────────────

const WS_A = '00000000-0000-4000-8000-000000000001'
const WS_B = '00000000-0000-4000-8000-000000000002'
const CHANNEL_A_IN_WS_A = '11111111-1111-4111-8111-111111111111'
const CHANNEL_B_IN_WS_B = '22222222-2222-4222-8222-222222222222'
const CHANNEL_DISABLED = '33333333-3333-4333-8333-333333333333'

interface FakeRes {
    statusCode: number
    body: unknown
    status: (n: number) => FakeRes
    json: (b: unknown) => FakeRes
}

function makeRes(): FakeRes {
    const r: FakeRes = {
        statusCode: 200,
        body: undefined,
        status(n) { this.statusCode = n; return this },
        json(b) { this.body = b; return this },
    }
    return r
}

function findRoute(method: string, path: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layer = (cronRouter as any).stack.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (l: any) => l.route && l.route.path === path && l.route.methods[method.toLowerCase()],
    )
    if (!layer) throw new Error(`Route not found: ${method} ${path}`)
    return layer.route.stack[0].handle as (req: unknown, res: unknown) => Promise<void>
}

// Channel-existence lookups go through select(...).from(channels).where(...).limit(1)
// We dispatch on the "from" arg key to choose what the select returns.
function setChannelLookup(rows: Array<Record<string, unknown>>) {
    mockSelectImpl.mockImplementation(() => ({
        from: () => ({ where: () => ({ limit: async () => rows }) }),
    }))
}

// GET list flow: select().from().where().orderBy() — orderBy returns the rows.
function setListReturns(rows: Array<Record<string, unknown>>) {
    mockSelectImpl.mockImplementation(() => ({
        from: () => ({ where: () => ({ orderBy: async () => rows }) }),
    }))
}

const insertedValues: Record<string, unknown>[] = []
function setInsertReturns(created: Record<string, unknown>) {
    mockInsertImpl.mockImplementation(() => ({
        values: (v: Record<string, unknown>) => {
            insertedValues.push(v)
            return { returning: async () => [created] }
        },
    }))
}

function setUpdateNoOp() {
    mockUpdateImpl.mockImplementation(() => ({
        set: () => ({ where: async () => undefined }),
    }))
}

function setDeleteNoOp() {
    mockDeleteImpl.mockImplementation(() => ({
        where: async () => undefined,
    }))
}

beforeEach(() => {
    insertedValues.length = 0
    mockSelectImpl.mockReset()
    mockInsertImpl.mockReset()
    mockUpdateImpl.mockReset()
    mockDeleteImpl.mockReset()
    setUpdateNoOp()
    setDeleteNoOp()
})

const futureIso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString()

// ── POST /api/cron ────────────────────────────────────────────────────────────

describe('POST /api/cron', () => {
    it('201 with schedule only — nextRunAt computed, schedule stored', async () => {
        setInsertReturns({ id: 'job-1', schedule: '*/5 * * * *' })
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'tick', schedule: '*/5 * * * *' } }
        const res = makeRes()
        await handle(req, res)

        expect(res.statusCode).toBe(201)
        expect(insertedValues[0]?.schedule).toBe('*/5 * * * *')
        expect(insertedValues[0]?.nextRunAt).toBeInstanceOf(Date)
        expect((insertedValues[0]?.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now())
        expect(insertedValues[0]?.taskType).toBe('general')
    })

    it('201 with scheduleAt only — schedule null, nextRunAt parsed', async () => {
        setInsertReturns({ id: 'job-2', schedule: null })
        const handle = findRoute('post', '/')
        const at = futureIso(60_000)
        const req = { body: { workspaceId: WS_A, name: 'remind', scheduleAt: at } }
        const res = makeRes()
        await handle(req, res)

        expect(res.statusCode).toBe(201)
        expect(insertedValues[0]?.schedule).toBeNull()
        expect((insertedValues[0]?.nextRunAt as Date).toISOString()).toBe(at)
    })

    it('400 when both schedule and scheduleAt are provided', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'x', schedule: '*/5 * * * *', scheduleAt: futureIso(60_000) } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_FIRE_MECHANISM')
    })

    it('400 when neither schedule nor scheduleAt is provided', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'x' } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_FIRE_MECHANISM')
    })

    it('400 when scheduleAt is in the past', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'x', scheduleAt: futureIso(-60_000) } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('SCHEDULE_AT_PAST')
    })

    it('400 when scheduleAt is more than 1 year in the future', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'x', scheduleAt: futureIso(400 * 24 * 60 * 60 * 1000) } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('SCHEDULE_AT_TOO_FAR')
    })

    it('400 when scheduleAt lacks timezone (ambiguous)', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'x', scheduleAt: '2099-01-01T12:00:00' } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_SCHEDULE_AT')
    })

    it('400 when taskType=reminder without taskContext.channelId', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { message: 'hi' } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('MISSING_CHANNEL')
    })

    it('400 when taskType=reminder without taskContext.message', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { channelId: CHANNEL_A_IN_WS_A } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('MISSING_MESSAGE')
    })

    it('400 when taskType=reminder and channel does not exist', async () => {
        setChannelLookup([]) // no rows
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { channelId: CHANNEL_A_IN_WS_A, message: 'hi' } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('CHANNEL_NOT_FOUND')
    })

    it('400 when taskType=reminder and channel belongs to a different workspace (IDOR guard)', async () => {
        // The route filters on (channels.id, channels.workspaceId) — when probing WS_A
        // for a channel that belongs to WS_B, the lookup returns no rows.
        setChannelLookup([])
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { channelId: CHANNEL_B_IN_WS_B, message: 'hi' } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('CHANNEL_NOT_FOUND')
    })

    it('400 when taskType=reminder and channel exists but is disabled', async () => {
        setChannelLookup([{ id: CHANNEL_DISABLED, type: 'gmail', config: { emailAddress: 'a@b.com' }, enabled: false }])
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { channelId: CHANNEL_DISABLED, message: 'hi' } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('CHANNEL_NOT_FOUND')
    })

    it('400 when taskType=reminder targets a non-gmail channel type', async () => {
        setChannelLookup([{ id: CHANNEL_A_IN_WS_A, type: 'telegram', config: { chatId: 12345 }, enabled: true }])
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { channelId: CHANNEL_A_IN_WS_A, message: 'hi' } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('REMINDER_CHANNEL_TYPE_NOT_SUPPORTED')
    })

    it('400 when taskType=reminder targets a gmail channel with empty emailAddress', async () => {
        setChannelLookup([{ id: CHANNEL_A_IN_WS_A, type: 'gmail', config: {}, enabled: true }])
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { channelId: CHANNEL_A_IN_WS_A, message: 'hi' } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('REMINDER_CHANNEL_NOT_CONFIGURED')
    })

    it('400 when taskType=reminder and message exceeds 4000 chars', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { channelId: CHANNEL_A_IN_WS_A, message: 'x'.repeat(4001) } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('MESSAGE_TOO_LONG')
    })

    it('201 when taskType=reminder with valid gmail channel — DB row carries channel,channelId,chatId,message', async () => {
        setChannelLookup([{ id: CHANNEL_A_IN_WS_A, type: 'gmail', config: { emailAddress: 'lin@example.com' }, enabled: true }])
        setInsertReturns({ id: 'job-3', schedule: null, taskType: 'reminder' })

        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', scheduleAt: futureIso(60_000), taskType: 'reminder', taskContext: { channelId: CHANNEL_A_IN_WS_A, message: 'hello' } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(201)
        expect(insertedValues[0]?.taskType).toBe('reminder')
        expect(insertedValues[0]?.schedule).toBeNull()
        const persisted = insertedValues[0]?.taskContext as Record<string, unknown>
        expect(persisted).toEqual({
            channel: 'gmail',
            channelId: CHANNEL_A_IN_WS_A,
            chatId: 'lin@example.com',
            message: 'hello',
        })
    })

    it('400 when reminder schedule has cadence < 5 minutes apart', async () => {
        setChannelLookup([{ id: CHANNEL_A_IN_WS_A, type: 'gmail', config: { emailAddress: 'a@b.com' }, enabled: true }])
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'r', schedule: '*/1 * * * *', taskType: 'reminder', taskContext: { channelId: CHANNEL_A_IN_WS_A, message: 'hi' } } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('REMINDER_CADENCE_TOO_FREQUENT')
    })

    it('400 when name exceeds 200 chars', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'x'.repeat(201), schedule: '*/5 * * * *' } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('NAME_TOO_LONG')
    })

    it('400 when taskType is not in the allow-list', async () => {
        const handle = findRoute('post', '/')
        const req = { body: { workspaceId: WS_A, name: 'x', schedule: '*/5 * * * *', taskType: 'banana' } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_TASK_TYPE')
    })
})

// ── PATCH /api/cron/:id ───────────────────────────────────────────────────────

describe('PATCH /api/cron/:id', () => {
    it('400 when both schedule and scheduleAt are supplied', async () => {
        const handle = findRoute('patch', '/:id')
        const req = {
            params: { id: '44444444-4444-4444-8444-444444444444' },
            body: { workspaceId: WS_A, schedule: '*/5 * * * *', scheduleAt: futureIso(60_000) },
        }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_FIRE_MECHANISM')
    })

    it('200 when switching reminder→general (no taskContext.channel required)', async () => {
        const handle = findRoute('patch', '/:id')
        const req = {
            params: { id: '44444444-4444-4444-8444-444444444444' },
            body: { workspaceId: WS_A, taskType: 'general' },
        }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(200)
    })

    it('400 when switching to reminder without channelId', async () => {
        const handle = findRoute('patch', '/:id')
        const req = {
            params: { id: '44444444-4444-4444-8444-444444444444' },
            body: { workspaceId: WS_A, taskType: 'reminder', taskContext: { message: 'hi' } },
        }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('MISSING_CHANNEL')
    })

    it('200 when switching scheduleAt → schedule (recomputes columns)', async () => {
        const handle = findRoute('patch', '/:id')
        const req = {
            params: { id: '44444444-4444-4444-8444-444444444444' },
            body: { workspaceId: WS_A, schedule: '0 */6 * * *' },
        }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(200)
    })

    it('400 when patching taskContext on existing reminder with cross-workspace channelId (IDOR)', async () => {
        // Lookup #1: existing-row taskType (returns reminder). Lookup #2: channel
        // probe in WS_A for a UUID owned by WS_B → empty rows → CHANNEL_NOT_FOUND.
        let call = 0
        mockSelectImpl.mockImplementation(() => ({
            from: () => ({
                where: () => ({
                    limit: async () => {
                        call += 1
                        if (call === 1) return [{ taskType: 'reminder' }]
                        return []
                    },
                }),
            }),
        }))
        const handle = findRoute('patch', '/:id')
        const req = {
            params: { id: '44444444-4444-4444-8444-444444444444' },
            body: { workspaceId: WS_A, taskContext: { channelId: CHANNEL_B_IN_WS_B, message: 'hi' } },
        }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('CHANNEL_NOT_FOUND')
    })
})

// ── GET /api/cron ─────────────────────────────────────────────────────────────

describe('GET /api/cron', () => {
    it('?type=reminder returns only schedule=null rows', async () => {
        const reminderRows = [
            { id: 'r1', schedule: null, name: 'remind me' },
        ]
        setListReturns(reminderRows)

        const handle = findRoute('get', '/')
        const req = { query: { workspaceId: WS_A, type: 'reminder' } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(200)
        const body = res.body as { items: unknown[]; total: number }
        expect(body.total).toBe(1)
        expect(body.items).toEqual(reminderRows)
    })

    it('?type=schedule returns only schedule!=null rows', async () => {
        const scheduleRows = [{ id: 's1', schedule: '*/5 * * * *', name: 'tick' }]
        setListReturns(scheduleRows)

        const handle = findRoute('get', '/')
        const req = { query: { workspaceId: WS_A, type: 'schedule' } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(200)
        expect((res.body as { total: number }).total).toBe(1)
    })

    it('no type filter returns both', async () => {
        const allRows = [
            { id: 'r1', schedule: null },
            { id: 's1', schedule: '*/5 * * * *' },
        ]
        setListReturns(allRows)
        const handle = findRoute('get', '/')
        const req = { query: { workspaceId: WS_A } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(200)
        expect((res.body as { total: number }).total).toBe(2)
    })

    it('?type=all returns both groups (alias for no filter)', async () => {
        const allRows = [
            { id: 'r1', schedule: null },
            { id: 's1', schedule: '*/5 * * * *' },
        ]
        setListReturns(allRows)
        const handle = findRoute('get', '/')
        const req = { query: { workspaceId: WS_A, type: 'all' } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(200)
        expect((res.body as { total: number }).total).toBe(2)
    })

    it('400 on unknown type', async () => {
        const handle = findRoute('get', '/')
        const req = { query: { workspaceId: WS_A, type: 'banana' } }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(400)
        expect((res.body as { error: { code: string } }).error.code).toBe('INVALID_TYPE')
    })
})

// ── DELETE /api/cron/:id ──────────────────────────────────────────────────────

describe('DELETE /api/cron/:id', () => {
    it('200 — works regardless of schedule null/non-null', async () => {
        const handle = findRoute('delete', '/:id')
        const req = {
            params: { id: '44444444-4444-4444-8444-444444444444' },
            query: { workspaceId: WS_A },
        }
        const res = makeRes()
        await handle(req, res)
        expect(res.statusCode).toBe(200)
        expect((res.body as { ok: boolean }).ok).toBe(true)
    })
})
