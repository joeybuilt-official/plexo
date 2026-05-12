// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Levio tool factory — emails and calendar events from the connected Levio account.
 *
 * Tools: levio__list_emails, levio__send_email, levio__summarize_today_emails,
 *   levio__list_events, levio__list_calendar_sources, levio__create_event,
 *   levio__update_event, levio__list_tasks, levio__create_task, levio__update_task
 *
 * Auth: PLEXO_SERVICE_KEY sent to Levio's /api/plexo/data endpoint.
 * Credential: { levio_user_id: string } — auto-installed by Levio on workspace creation.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { createHmac } from 'node:crypto'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import { decrypt } from '../crypto-util.js'
import pino from 'pino'

const logger = pino({ name: 'levio:tools' })

function levioBase(): string {
    return (process.env.LEVIO_INTERNAL_URL ?? 'http://service:3000').replace(/\/$/, '')
}

function serviceHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY ?? ''}`,
        'Content-Type': 'application/json',
    }
}

/**
 * Fire-and-forget webhook notification to Levio when a bridge tool completes.
 * Payload is metadata-only -- no PII.
 */
function emitToolEvent(toolName: string, success: boolean, workspaceId: string): void {
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!serviceKey) return

    const payload = JSON.stringify({
        event: 'tool.invoked',
        tool: toolName,
        result: { success },
        workspaceId,
        userId: '', // no PII
        timestamp: new Date().toISOString(),
    })

    const signature = createHmac('sha256', serviceKey).update(payload).digest('hex')

    fetch(`${levioBase()}/api/plexo/events`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Plexo-Signature': signature,
        },
        body: payload,
        signal: AbortSignal.timeout(5_000),
    }).catch((err) => {
        logger.debug({ err, toolName }, 'Levio event webhook failed (non-fatal)')
    })
}

/**
 * Look up the IANA timezone of the Levio user connected to this workspace.
 * Returns `null` when there is no Levio connection or the lookup fails so the
 * caller can decide how to degrade (usually: skip the timezone prompt block).
 * Used by the prompt builder to format times in the user's local zone.
 */
export async function getLevioUserTimezone(workspaceId: string): Promise<string | null> {
    try {
        const { db, eq, and, installedConnections } = await import('@plexo/db')
        const [row] = await db
            .select({ credentials: installedConnections.credentials })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.registryId, 'levio'),
                eq(installedConnections.status, 'active'),
            ))
            .limit(1)
        if (!row) return null

        const rawCreds = (row.credentials ?? {}) as { encrypted?: string; levio_user_id?: string }
        let luid = rawCreds.levio_user_id
        if (!luid && rawCreds.encrypted) {
            try {
                const decrypted = JSON.parse(decrypt(rawCreds.encrypted, workspaceId)) as { levio_user_id?: string }
                luid = decrypted.levio_user_id
            } catch {
                return null
            }
        }
        if (!luid) return null

        const res = await fetch(`${levioBase()}/api/plexo/data?entity=preferences&userId=${encodeURIComponent(luid)}`, {
            headers: serviceHeaders(),
            signal: AbortSignal.timeout(3_000),
        })
        if (!res.ok) return null
        const data = await res.json() as { timezone?: string }
        return data.timezone ?? null
    } catch {
        return null
    }
}

export const LEVIO_TOOLS = (
    creds: ConnectionCredentials,
    opts: { connectionId: string; workspaceId: string },
): ToolSet => {
    const userId = (creds.levio_user_id as string) ?? ''
    if (!userId) {
        logger.warn({ connectionId: opts.connectionId }, 'Levio connection missing levio_user_id — tools will return errors')
    }

    /** Wraps a tool execute fn to emit a webhook event on completion. */
    function withEvent<TArgs, TResult>(
        toolName: string,
        fn: (args: TArgs) => Promise<TResult>,
    ): (args: TArgs) => Promise<TResult> {
        return async (args: TArgs) => {
            let success = true
            try {
                const result = await fn(args)
                if (typeof result === 'string' && /^Levio (error|.*failed)/i.test(result)) {
                    success = false
                }
                return result
            } catch (err) {
                success = false
                throw err
            } finally {
                emitToolEvent(toolName, success, opts.workspaceId)
            }
        }
    }

    return {
        levio__list_emails: tool({
            description:
                'List emails from the connected Levio account. Returns subject, sender, AI category, and summary. ' +
                'Categories: action (needs response/action), fyi (informational), waiting (awaiting reply), ' +
                'delegate (needs someone else), archive (done). Default returns all non-archived emails.',
            inputSchema: z.object({
                category: z.enum(['action', 'fyi', 'waiting', 'delegate', 'archive', 'all']).optional()
                    .describe('Filter by AI category. Omit for all non-archived emails.'),
                limit: z.number().optional().default(20).describe('Max emails to return (max 100)'),
            }),
            execute: withEvent('levio__list_emails', async ({ category, limit = 20 }: { category?: string; limit?: number }) => {
                try {
                    const params = new URLSearchParams({ entity: 'email', userId, limit: String(limit) })
                    if (category) params.set('category', category)
                    const res = await fetch(`${levioBase()}/api/plexo/data?${params}`, {
                        headers: serviceHeaders(),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { emails: Array<{ id: string; subject?: string; senderName?: string; senderEmail?: string; aiSummary?: string; aiCategory?: string; receivedAt?: string; isRead?: boolean }>; total: number }
                    if (!data.emails?.length) return 'No emails found.'
                    logger.info({ workspaceId: opts.workspaceId, count: data.emails.length }, 'levio__list_emails')
                    return data.emails.map((e) =>
                        `[${e.aiCategory ?? 'uncategorized'}] ${e.subject ?? '(no subject)'}\n  From: ${e.senderName ?? ''} <${e.senderEmail ?? ''}> | ${e.receivedAt ? new Date(e.receivedAt).toLocaleString() : ''}\n  ${e.aiSummary ?? ''}`.trim()
                    ).join('\n\n')
                } catch (err) {
                    return `Levio list_emails failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__list_events: tool({
            description:
                'List calendar events from the connected Levio account. Defaults to the next 7 days.',
            inputSchema: z.object({
                date: z.string().optional().describe('Specific date YYYY-MM-DD to get events for'),
                start: z.string().optional().describe('Start of date range (ISO 8601)'),
                end: z.string().optional().describe('End of date range (ISO 8601)'),
            }),
            execute: withEvent('levio__list_events', async ({ date, start, end }: { date?: string; start?: string; end?: string }) => {
                try {
                    const params = new URLSearchParams({ entity: 'calendar', userId })
                    if (date) params.set('date', date)
                    if (start) params.set('start', start)
                    if (end) params.set('end', end)
                    const res = await fetch(`${levioBase()}/api/plexo/data?${params}`, {
                        headers: serviceHeaders(),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { events: Array<{ id: string; title?: string; startAt?: string; endAt?: string; location?: string; descriptionSummary?: string; attendees?: unknown[]; calendarName?: string | null; calendarSourceProviderId?: string | null }>; total: number }
                    if (!data.events?.length) return 'No calendar events found in the given range.'
                    logger.info({ workspaceId: opts.workspaceId, count: data.events.length }, 'levio__list_events')
                    return data.events.map((e) => {
                        const startTime = e.startAt ? new Date(e.startAt).toLocaleString() : '?'
                        const endTime = e.endAt ? new Date(e.endAt).toLocaleString() : '?'
                        const attendeeCount = Array.isArray(e.attendees) ? e.attendees.length : 0
                        const calLabel = e.calendarName ? ` [${e.calendarName}]` : ''
                        return `${e.title ?? '(untitled)'}${calLabel} | ${startTime} → ${endTime}${e.location ? ` | ${e.location}` : ''}${attendeeCount > 0 ? ` | ${attendeeCount} attendees` : ''}`
                    }).join('\n')
                } catch (err) {
                    return `Levio list_events failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__send_email: tool({
            description:
                'Send an email through the connected Levio email account. ' +
                'Requires escalation approval before execution.',
            inputSchema: z.object({
                to: z.string().describe('Recipient email address'),
                subject: z.string().describe('Email subject line'),
                body: z.string().describe('Email body text'),
                replyToId: z.string().optional().describe('Email ID to reply to (for threading). Omit for new emails.'),
            }),
            execute: withEvent('levio__send_email', async ({ to, subject, body: emailBody, replyToId }: { to: string; subject: string; body: string; replyToId?: string }) => {
                try {
                    const res = await fetch(`${levioBase()}/api/plexo/data`, {
                        method: 'POST',
                        headers: serviceHeaders(),
                        body: JSON.stringify({ entity: 'email', action: 'send', userId, to, subject, body: emailBody, replyToId }),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { messageId?: string }
                    return `Email sent to ${to}: "${subject}" (ID: ${data.messageId ?? 'unknown'})`
                } catch (err) {
                    return `Levio send_email failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__summarize_today_emails: tool({
            description:
                'Get an AI-generated summary of today\'s emails from the connected Levio account. ' +
                'Returns categorized overview with action items highlighted.',
            inputSchema: z.object({}),
            execute: withEvent('levio__summarize_today_emails', async () => {
                try {
                    const today = new Date().toISOString().slice(0, 10)
                    const params = new URLSearchParams({ entity: 'email', userId, limit: '50', since: today })
                    const res = await fetch(`${levioBase()}/api/plexo/data?${params}`, {
                        headers: serviceHeaders(),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { emails: Array<{ subject?: string; senderName?: string; aiSummary?: string; aiCategory?: string }>; total: number }
                    if (!data.emails?.length) return 'No emails received today.'
                    const byCategory: Record<string, string[]> = {}
                    for (const e of data.emails) {
                        const cat = e.aiCategory ?? 'uncategorized'
                        if (!byCategory[cat]) byCategory[cat] = []
                        byCategory[cat]!.push(`- ${e.subject ?? '(no subject)'} from ${e.senderName ?? 'unknown'}: ${e.aiSummary ?? ''}`)
                    }
                    const lines: string[] = [`Today's emails (${data.total} total):`]
                    for (const [cat, items] of Object.entries(byCategory)) {
                        lines.push(`\n[${cat.toUpperCase()}] (${items.length})`)
                        lines.push(...items)
                    }
                    return lines.join('\n')
                } catch (err) {
                    return `Levio summarize_today failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__list_calendar_sources: tool({
            description:
                'List the calendars available on the connected Levio account ' +
                '(e.g. Personal, Family, Work). Returns each calendar\'s name, providerId, ' +
                'color, and primary/enabled flags. Call this before creating an event so ' +
                'you know which calendar to target.',
            inputSchema: z.object({}),
            execute: withEvent('levio__list_calendar_sources', async () => {
                try {
                    const params = new URLSearchParams({ entity: 'calendar_sources', userId })
                    const res = await fetch(`${levioBase()}/api/plexo/data?${params}`, {
                        headers: serviceHeaders(),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { sources: Array<{ name: string; providerId: string; color?: string | null; isPrimary: boolean; enabled: boolean }>; total: number }
                    if (!data.sources?.length) return 'No calendars found. The user may not have a calendar provider connected.'
                    return data.sources.map((s) =>
                        `- ${s.name}${s.isPrimary ? ' (primary)' : ''}${s.enabled ? '' : ' [disabled]'} -- calendarId: ${s.providerId}`
                    ).join('\n')
                } catch (err) {
                    return `Levio list_calendar_sources failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__create_event: tool({
            description:
                'Create a calendar event in the connected Levio account. ' +
                'When the user specifies a calendar (e.g., "my family calendar"), use ' +
                'levio__list_calendar_sources first to find the calendarId, then pass it here. ' +
                'Defaults to the user\'s primary calendar when calendarId is omitted. ' +
                'For recurring events, use standard RRULE format in the recurrence parameter: ' +
                'RRULE:FREQ=WEEKLY;BYDAY=WE for every Wednesday, RRULE:FREQ=DAILY for daily, etc.',
            inputSchema: z.object({
                title: z.string().describe('Event title'),
                startAt: z.string().describe('Event start time (ISO 8601)'),
                endAt: z.string().describe('Event end time (ISO 8601)'),
                calendarId: z.string().optional().describe('Calendar providerId to create on. Defaults to primary.'),
                recurrence: z.string().optional().describe('RRULE string for recurring events (e.g. "RRULE:FREQ=WEEKLY;BYDAY=WE" for every Wednesday, "RRULE:FREQ=DAILY" for daily).'),
                location: z.string().optional().describe('Event location'),
                description: z.string().optional().describe('Event description'),
            }),
            execute: withEvent('levio__create_event', async ({ title, startAt, endAt, calendarId, recurrence, location, description }: { title: string; startAt: string; endAt: string; calendarId?: string; recurrence?: string; location?: string; description?: string }) => {
                try {
                    const res = await fetch(`${levioBase()}/api/plexo/data`, {
                        method: 'POST',
                        headers: serviceHeaders(),
                        body: JSON.stringify({ entity: 'calendar', action: 'create', userId, title, startAt, endAt, calendarId, recurrence, location, description }),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { event?: { id: string; title: string } }
                    return `Event created: "${data.event?.title ?? title}" (ID: ${data.event?.id ?? 'unknown'})`
                } catch (err) {
                    return `Levio create_event failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__update_event: tool({
            description: 'Update an existing calendar event in the connected Levio account.',
            inputSchema: z.object({
                eventId: z.string().describe('ID of the event to update'),
                title: z.string().optional().describe('Updated event title'),
                startAt: z.string().optional().describe('Updated start time (ISO 8601)'),
                endAt: z.string().optional().describe('Updated end time (ISO 8601)'),
                location: z.string().optional().describe('Updated location'),
            }),
            execute: withEvent('levio__update_event', async ({ eventId, title, startAt, endAt, location }: { eventId: string; title?: string; startAt?: string; endAt?: string; location?: string }) => {
                try {
                    const updates: Record<string, unknown> = {}
                    if (title !== undefined) updates.title = title
                    if (startAt !== undefined) updates.startAt = startAt
                    if (endAt !== undefined) updates.endAt = endAt
                    if (location !== undefined) updates.location = location
                    const res = await fetch(`${levioBase()}/api/plexo/data`, {
                        method: 'POST',
                        headers: serviceHeaders(),
                        body: JSON.stringify({ entity: 'calendar', action: 'update', userId, eventId, ...updates }),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { event?: { id: string; title: string } }
                    return `Event updated: "${data.event?.title ?? 'unknown'}" (ID: ${eventId})`
                } catch (err) {
                    return `Levio update_event failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__list_tasks: tool({
            description: 'List tasks from the connected Levio account. Returns title, status, priority, and due date.',
            inputSchema: z.object({
                status: z.enum(['inbox', 'scheduled', 'done', 'someday']).optional()
                    .describe('Filter by task status. Omit for all non-done tasks.'),
                limit: z.number().optional().default(30).describe('Max tasks to return'),
            }),
            execute: withEvent('levio__list_tasks', async ({ status, limit = 30 }: { status?: string; limit?: number }) => {
                try {
                    const params = new URLSearchParams({ entity: 'task', userId, limit: String(limit) })
                    if (status) params.set('status', status)
                    const res = await fetch(`${levioBase()}/api/plexo/data?${params}`, {
                        headers: serviceHeaders(),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { tasks: Array<{ id: string; title: string; status: string; priority?: string; dueDate?: string }>; total: number }
                    if (!data.tasks?.length) return 'No tasks found.'
                    return data.tasks.map((t) =>
                        `[${t.status}] ${t.title}${t.priority ? ` (${t.priority})` : ''}${t.dueDate ? ` -- due ${t.dueDate}` : ''}`
                    ).join('\n')
                } catch (err) {
                    return `Levio list_tasks failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__create_task: tool({
            description: 'Create a task in the connected Levio account.',
            inputSchema: z.object({
                title: z.string().describe('Task title'),
                priority: z.enum(['low', 'medium', 'high']).optional().describe('Task priority'),
                dueDate: z.string().optional().describe('Due date YYYY-MM-DD'),
            }),
            execute: withEvent('levio__create_task', async ({ title, priority, dueDate }: { title: string; priority?: string; dueDate?: string }) => {
                try {
                    const res = await fetch(`${levioBase()}/api/plexo/data`, {
                        method: 'POST',
                        headers: serviceHeaders(),
                        body: JSON.stringify({ entity: 'task', userId, title, priority, dueDate }),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { task: { id: string; title: string } }
                    logger.info({ workspaceId: opts.workspaceId, taskId: data.task?.id }, 'levio__create_task')
                    return `Task created: "${data.task?.title ?? title}" (ID: ${data.task?.id})`
                } catch (err) {
                    return `Levio create_task failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),

        levio__update_task: tool({
            description: 'Update an existing task in the connected Levio account (status, title, priority, due date).',
            inputSchema: z.object({
                taskId: z.string().describe('ID of the task to update'),
                title: z.string().optional().describe('Updated task title'),
                status: z.enum(['inbox', 'scheduled', 'done', 'someday']).optional().describe('Updated task status'),
                priority: z.enum(['low', 'medium', 'high']).optional().describe('Updated task priority'),
                dueDate: z.string().optional().describe('Updated due date YYYY-MM-DD'),
            }),
            execute: withEvent('levio__update_task', async ({ taskId, title, status, priority, dueDate }: { taskId: string; title?: string; status?: string; priority?: string; dueDate?: string }) => {
                try {
                    const updates: Record<string, unknown> = {}
                    if (title !== undefined) updates.title = title
                    if (status !== undefined) updates.status = status
                    if (priority !== undefined) updates.priority = priority
                    if (dueDate !== undefined) updates.dueDate = dueDate
                    const res = await fetch(`${levioBase()}/api/plexo/data`, {
                        method: 'POST',
                        headers: serviceHeaders(),
                        body: JSON.stringify({ entity: 'task', action: 'update', userId, taskId, ...updates }),
                        signal: AbortSignal.timeout(10_000),
                    })
                    if (!res.ok) return `Levio error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { task?: { id: string; title: string } }
                    return `Task updated: "${data.task?.title ?? 'unknown'}" (ID: ${taskId})`
                } catch (err) {
                    return `Levio update_task failed: ${err instanceof Error ? err.message : String(err)}`
                }
            }),
        }),
    }
}
