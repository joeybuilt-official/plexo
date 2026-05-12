// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for parseNl one-shot patterns (Phase L4 Stage 2).
 *
 * Pure-function tests — no Express server, no DB. We import the parser via the
 * `__parseNlForTest` export and pass a fixed `now` so date math is deterministic.
 *
 * The `@plexo/db` import in routes/cron.ts is heavy (drizzle, postgres driver),
 * so we mock it out at module load to keep this file pure-logic.
 */

import { describe, it, expect, vi, beforeAll } from 'vitest'

vi.mock('@plexo/db', () => ({
    db: {},
    cronJobs: {},
    channels: {},
    taskTypeEnum: { enumValues: ['general', 'reminder'] },
    eq: vi.fn(),
    and: vi.fn(),
    desc: vi.fn(),
    isNull: vi.fn(),
    isNotNull: vi.fn(),
}))
vi.mock('@plexo/queue', () => ({ push: vi.fn() }))
vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../event-tracker.js', () => ({ trackEvent: vi.fn() }))
vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async () => true),
}))

let parseNl: typeof import('../cron.js').__parseNlForTest

beforeAll(async () => {
    const mod = await import('../cron.js')
    parseNl = mod.__parseNlForTest
})

// Fixed reference time: Mon 2026-05-04 14:00:00 local. Day 1 = Monday.
const now = new Date(2026, 4, 4, 14, 0, 0, 0)

// Narrow the union to the one-shot variant for ergonomic test access.
function asOneShot(r: ReturnType<typeof parseNl>): { cron: null; scheduleAt: string; description: string } {
    if (!r || !('scheduleAt' in r) || typeof r.scheduleAt !== 'string') {
        throw new Error(`expected one-shot, got: ${JSON.stringify(r)}`)
    }
    return r as { cron: null; scheduleAt: string; description: string }
}

describe('parseNl one-shot patterns', () => {
    it('"in 2 hours" → ISO 2 hours from now', () => {
        const r = parseNl('in 2 hours', now)
        expect(r).toMatchObject({ cron: null, description: expect.stringContaining('In 2') })
        // 14:00 + 2h = 16:00
        expect(new Date(asOneShot(r).scheduleAt).getTime()).toBe(now.getTime() + 2 * 60 * 60_000)
    })

    it('"in 30 minutes" → ISO 30 min from now', () => {
        const r = parseNl('in 30 minutes', now)
        expect(r).toMatchObject({ cron: null })
        expect(new Date(asOneShot(r).scheduleAt).getTime()).toBe(now.getTime() + 30 * 60_000)
    })

    it('"in 3 days" → ISO 3 days from now (same time-of-day)', () => {
        const r = parseNl('in 3 days', now)
        expect(r).toMatchObject({ cron: null })
        expect(new Date(asOneShot(r).scheduleAt).getTime()).toBe(now.getTime() + 3 * 24 * 60 * 60_000)
    })

    it('"tomorrow at 9am" → next day 09:00 local', () => {
        const r = parseNl('tomorrow at 9am', now)
        expect(r).toMatchObject({ cron: null, description: expect.stringContaining('Tomorrow') })
        const at = new Date(asOneShot(r).scheduleAt)
        expect(at.getDate()).toBe(5) // May 5
        expect(at.getHours()).toBe(9)
        expect(at.getMinutes()).toBe(0)
    })

    it('"tomorrow at 3pm" → next day 15:00 local', () => {
        const r = parseNl('tomorrow at 3pm', now)
        const at = new Date(asOneShot(r).scheduleAt)
        expect(at.getHours()).toBe(15)
    })

    it('"today at 9am" rolls forward to tomorrow when past', () => {
        // now is 14:00; 9am today is in the past
        const r = parseNl('today at 9am', now)
        expect(r).toMatchObject({ cron: null, description: expect.stringMatching(/today already past|Tomorrow/i) })
        const at = new Date(asOneShot(r).scheduleAt)
        expect(at.getDate()).toBe(5)
        expect(at.getHours()).toBe(9)
    })

    it('"today at 6pm" returns same-day when still future', () => {
        const r = parseNl('today at 6pm', now)
        expect(r).toMatchObject({ cron: null, description: expect.stringContaining('Today') })
        const at = new Date(asOneShot(r).scheduleAt)
        expect(at.getDate()).toBe(4)
        expect(at.getHours()).toBe(18)
    })

    it('"next Tuesday at 9am" → 8 days ahead when today is Mon (next-week semantics)', () => {
        // From Mon 5/4, "next Tuesday" semantics in this parser = smallest [1,7]
        // delta. Tue=2, Mon=1: delta = (2-1+7)%7 = 1 → 5/5 (Tue). That matches
        // common usage of "next Tuesday" said on a Monday: tomorrow.
        const r = parseNl('next tuesday at 9am', now)
        const at = new Date(asOneShot(r).scheduleAt)
        expect(at.getDate()).toBe(5)
        expect(at.getDay()).toBe(2)
        expect(at.getHours()).toBe(9)
    })

    it('"next Monday at 10am" rolls a full week when today IS Monday', () => {
        const r = parseNl('next monday at 10am', now)
        const at = new Date(asOneShot(r).scheduleAt)
        // Mon → Mon: delta=0 → bumped to 7 by "explicit next" rule.
        expect(at.getDate()).toBe(11)
        expect(at.getDay()).toBe(1)
        expect(at.getHours()).toBe(10)
    })

    it('"at 3pm on 2026-12-25" → explicit date+time future', () => {
        const r = parseNl('at 3pm on 2026-12-25', now)
        expect(r).toMatchObject({ cron: null })
        const at = new Date(asOneShot(r).scheduleAt)
        expect(at.getFullYear()).toBe(2026)
        expect(at.getMonth()).toBe(11)
        expect(at.getDate()).toBe(25)
        expect(at.getHours()).toBe(15)
    })

    it('"at 9am on 2020-01-01" → PAST_TIME error', () => {
        const r = parseNl('at 9am on 2020-01-01', now) as { error: string }
        expect(r.error).toBe('PAST_TIME')
    })

    it('input over 200 chars → null (DoS guard)', () => {
        const longText = 'in 1 hour ' + 'x'.repeat(250)
        expect(parseNl(longText, now)).toBeNull()
    })

    it('unknown phrase → null (no spurious match)', () => {
        expect(parseNl('schedule something fancy', now)).toBeNull()
    })

    it('recurring patterns still return { cron, description } with no scheduleAt', () => {
        const r = parseNl('daily at 9am', now)
        expect(r).toMatchObject({ cron: '0 9 * * *', description: expect.stringContaining('Daily') })
        expect((r as any).scheduleAt).toBeUndefined()
    })
})
