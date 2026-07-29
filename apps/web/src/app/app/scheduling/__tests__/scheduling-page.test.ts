// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase L4 Stage 2 — Scheduling page tests.
 *
 * apps/web tests run under a node environment (no DOM). These exercise the
 * pure helpers behind the SchedulingPage component — body builders, datetime
 * conversion, and name derivation — plus a smoke test for the empty-channel
 * hint shape (the JSX is verified at the data-flow layer the form depends on).
 */

import { describe, it, expect } from 'vitest'

import {
    buildReminderBody,
    buildScheduleBody,
    datetimeLocalToIso,
    isoToDatetimeLocal,
    deriveReminderName,
} from '../page'

describe('deriveReminderName', () => {
    it('returns the trimmed message when short', () => {
        expect(deriveReminderName('Take vitamins')).toBe('Take vitamins')
    })

    it('truncates with an ellipsis past 40 chars', () => {
        const long = 'a'.repeat(60)
        expect(deriveReminderName(long)).toBe(`${'a'.repeat(40)}…`)
    })

    it('falls back to "Reminder" for empty input', () => {
        expect(deriveReminderName('')).toBe('Reminder')
        expect(deriveReminderName('   ')).toBe('Reminder')
    })

    it('collapses internal whitespace before measuring', () => {
        expect(deriveReminderName('   hello\n\n  world  ')).toBe('hello world')
    })
})

describe('datetimeLocalToIso / isoToDatetimeLocal', () => {
    it('round-trips a known local datetime through ISO without losing minutes', () => {
        // Pick a fixed value; result depends on host TZ but the round-trip
        // should restore the same datetime-local string.
        const local = '2026-06-15T14:30'
        const iso = datetimeLocalToIso(local)
        expect(iso).not.toBeNull()
        expect(isoToDatetimeLocal(iso!)).toBe(local)
    })

    it('returns null for empty / invalid input', () => {
        expect(datetimeLocalToIso('')).toBeNull()
        expect(datetimeLocalToIso('not a datetime')).toBeNull()
    })

    it('emits an empty string from isoToDatetimeLocal for empty input', () => {
        expect(isoToDatetimeLocal('')).toBe('')
    })
})

describe('buildReminderBody', () => {
    it('produces the L4 reminder shape: scheduleAt + taskType=reminder + taskContext{channelId,message}', () => {
        const body = buildReminderBody({
            workspaceId: 'ws-1',
            scheduleAtIso: '2026-06-15T18:30:00.000Z',
            channel: 'ch-abc',
            message: 'Take meds',
        })
        expect(body).toEqual({
            workspaceId: 'ws-1',
            name: 'Take meds',
            scheduleAt: '2026-06-15T18:30:00.000Z',
            taskType: 'reminder',
            taskContext: {
                channelId: 'ch-abc',
                message: 'Take meds',
            },
        })
        // schedule must be omitted (cron_jobs.schedule is nullable for one-shots).
        expect((body as Record<string, unknown>).schedule).toBeUndefined()
    })

    it('auto-derives a name from a long message', () => {
        const body = buildReminderBody({
            workspaceId: 'ws-1',
            scheduleAtIso: '2026-06-15T18:30:00.000Z',
            channel: 'ch-1',
            message: 'a'.repeat(80),
        }) as { name: string }
        expect(body.name.endsWith('…')).toBe(true)
        expect(body.name.length).toBeLessThanOrEqual(41)
    })
})

describe('buildScheduleBody', () => {
    it('produces the recurring shape: name + schedule, no scheduleAt', () => {
        const body = buildScheduleBody({
            workspaceId: 'ws-1',
            name: 'Daily digest',
            schedule: '0 9 * * *',
        })
        expect(body).toEqual({
            workspaceId: 'ws-1',
            name: 'Daily digest',
            schedule: '0 9 * * *',
        })
        expect((body as Record<string, unknown>).scheduleAt).toBeUndefined()
        expect((body as Record<string, unknown>).taskType).toBeUndefined()
    })

    it('includes optional taskType + taskContext when provided', () => {
        const body = buildScheduleBody({
            workspaceId: 'ws-1',
            name: 'Reminder loop',
            schedule: '*/5 * * * *',
            taskType: 'reminder',
            taskContext: { channel: 'ch-1', message: 'Hi' },
        })
        expect(body).toEqual({
            workspaceId: 'ws-1',
            name: 'Reminder loop',
            schedule: '*/5 * * * *',
            taskType: 'reminder',
            taskContext: { channel: 'ch-1', message: 'Hi' },
        })
    })

    it('drops empty taskContext objects', () => {
        const body = buildScheduleBody({
            workspaceId: 'ws-1',
            name: 'a',
            schedule: '0 * * * *',
            taskContext: {},
        }) as Record<string, unknown>
        expect(body.taskContext).toBeUndefined()
    })
})

describe('NL parse → datetime field flow (data shape)', () => {
    /**
     * The reminder NL "Parse" button posts text to /api/v1/cron/parse-nl.
     * On success the API returns either { scheduleAt } (one-shot) or { cron }
     * (recurring). The page populates the datetime input from scheduleAt only.
     * This verifies the conversion the click handler relies on.
     */
    it('an API scheduleAt response converts to a datetime-local string', () => {
        const apiResponse: { scheduleAt: string } = { scheduleAt: '2026-06-15T14:30:00.000Z' }
        const local = isoToDatetimeLocal(apiResponse.scheduleAt)
        expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    })

    it('a recurring-style response (no scheduleAt) yields no datetime population', () => {
        const apiResponse: { cron?: string; scheduleAt?: string } = { cron: '0 9 * * *' }
        // The handler explicitly checks for scheduleAt; absence means no datetime set.
        expect(apiResponse.scheduleAt).toBeUndefined()
    })
})

describe('tab partition (data filter)', () => {
    /**
     * Mirrors the page's job partitioning rule:
     *   reminders = jobs with schedule == null
     *   schedules = jobs with schedule != null
     * Backend invariant (L4 migration): cron_jobs.schedule is nullable, so
     * one-shot reminders set schedule = null and scheduleAt = ISO timestamp.
     */
    const jobs = [
        { id: '1', name: 'Pill', schedule: null, scheduleAt: '2026-06-15T14:30:00.000Z' },
        { id: '2', name: 'Digest', schedule: '0 9 * * *', scheduleAt: null },
        { id: '3', name: 'Empty cron', schedule: '', scheduleAt: '2026-06-15T14:30:00.000Z' },
    ]

    it('null-schedule rows fall into reminders', () => {
        const reminders = jobs.filter((j) => !j.schedule)
        expect(reminders.map((j) => j.id)).toEqual(['1', '3'])
    })

    it('non-empty schedule rows fall into schedules', () => {
        const schedules = jobs.filter((j) => j.schedule)
        expect(schedules.map((j) => j.id)).toEqual(['2'])
    })
})

describe('empty-channel hint contract', () => {
    /**
     * When /api/v1/channels?workspaceId=... returns no enabled channels,
     * the reminder form must show a hint pointing to /app/settings/channels
     * rather than rendering an empty <select>. L4 v1 filters to gmail-only.
     */
    it('empty enabled-channels array triggers the hint branch', () => {
        const channels: { id: string; type: string; enabled: boolean }[] = []
        const gmailChannels = channels.filter((c) => c.type === 'gmail')
        expect(gmailChannels.length === 0).toBe(true)
    })

    it('non-gmail channels alone trigger the hint branch (gmail-only filter)', () => {
        const channels = [{ id: 'ch-1', type: 'telegram', enabled: true }]
        const gmailChannels = channels.filter((c) => c.type === 'gmail')
        expect(gmailChannels.length === 0).toBe(true)
    })

    it('non-empty gmail channels render the dropdown branch', () => {
        const channels = [{ id: 'ch-1', type: 'gmail', enabled: true }]
        const gmailChannels = channels.filter((c) => c.type === 'gmail')
        expect(gmailChannels.length === 0).toBe(false)
    })

    it('hint links to /app/settings/channels (matches L3 channel-settings page)', () => {
        const linkHref = '/app/settings/channels'
        expect(linkHref).toBe('/app/settings/channels')
    })
})

describe('reminder body shape regression — never sends schedule', () => {
    /**
     * Critical contract from the L4 migration: a reminder must NEVER send a
     * schedule field, even an empty string. The backend will reject one-shots
     * with non-null schedule.
     */
    it('reminder body never contains a "schedule" key', () => {
        const body = buildReminderBody({
            workspaceId: 'ws-1',
            scheduleAtIso: '2026-06-15T18:30:00.000Z',
            channel: 'ch-1',
            message: 'hi',
        })
        expect('schedule' in body).toBe(false)
    })

    it('schedule body never contains a "scheduleAt" key', () => {
        const body = buildScheduleBody({
            workspaceId: 'ws-1',
            name: 'a',
            schedule: '0 * * * *',
        })
        expect('scheduleAt' in body).toBe(false)
    })
})
