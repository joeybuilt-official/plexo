// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Google Workspace tool factory — Gmail, Google Calendar, and Google Drive.
 *
 * Tools: gws__list_emails, gws__read_email, gws__send_email,
 *        gws__list_events, gws__create_event, gws__update_event, gws__delete_event,
 *        gws__search_drive, gws__get_file, gws__create_file
 *
 * Auth: OAuth2 access_token with Gmail, Calendar, and Drive scopes.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import { buildMime } from '../../channels/multipart-builder.js'
import {
    getOutboundAttachmentsHandler,
    type OutboundAttachmentInput,
} from '../../channels/outbound-attachments-port.js'
import pino from 'pino'

const logger = pino({ name: 'gws:tools' })

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1'
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'

function authHeader(creds: ConnectionCredentials): string {
    return `Bearer ${(creds.access_token as string) ?? ''}`
}

function log(
    toolName: string,
    detail: Record<string, unknown>,
    opts: { connectionId: string; workspaceId: string },
) {
    logger.info(
        { type: 'gws_tool_call', toolName, connectionId: opts.connectionId, workspaceId: opts.workspaceId, ...detail },
        `Google Workspace tool: ${toolName}`,
    )
}

function base64url(s: string): string {
    return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function buildRfc2822(to: string, subject: string, body: string): string {
    return [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"', '', body].join('\r\n')
}

export const GOOGLE_WORKSPACE_TOOLS = (
    creds: ConnectionCredentials,
    opts: { connectionId: string; workspaceId: string },
): ToolSet => {
    const auth = authHeader(creds)
    const jsonHeaders = { Authorization: auth, 'Content-Type': 'application/json' }
    const getHeaders = { Authorization: auth }

    return {
        // ── Gmail ──────────────────────────────────────────────────────────────

        gws__list_emails: tool({
            description:
                'List Gmail messages. Returns IDs, subjects, senders, and snippets. Supports Gmail search query syntax.',
            inputSchema: z.object({
                query: z.string().optional().describe('Gmail search query, e.g. "is:unread from:boss@example.com"'),
                limit: z.number().optional().default(10),
            }),
            execute: async ({ query, limit = 10 }) => {
                try {
                    const params = new URLSearchParams({ maxResults: String(Math.min(limit, 50)) })
                    if (query) params.set('q', query)
                    const listRes = await fetch(`${GMAIL_BASE}/users/me/messages?${params}`, { headers: getHeaders })
                    if (!listRes.ok) return `Gmail error ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`
                    const listData = await listRes.json() as {
                        messages?: Array<{ id: string }>
                    }
                    if (!listData.messages?.length) return 'No messages found.'

                    const ids = listData.messages.slice(0, Math.min(limit, 15)).map((m) => m.id)
                    const messages = await Promise.all(
                        ids.map(async (id) => {
                            const msgRes = await fetch(
                                `${GMAIL_BASE}/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
                                { headers: getHeaders },
                            )
                            if (!msgRes.ok) return `${id}: (error fetching)`
                            const msg = await msgRes.json() as {
                                id: string
                                snippet?: string
                                payload?: { headers?: Array<{ name: string; value: string }> }
                            }
                            const hdrs = msg.payload?.headers ?? []
                            const subject = hdrs.find((h) => h.name === 'Subject')?.value ?? '(no subject)'
                            const from = hdrs.find((h) => h.name === 'From')?.value ?? '(unknown)'
                            const date = hdrs.find((h) => h.name === 'Date')?.value ?? ''
                            return `[${id}] ${subject}\n  From: ${from} | ${date}\n  ${msg.snippet ?? ''}`
                        }),
                    )
                    log('gws__list_emails', { query, count: messages.length }, opts)
                    return messages.join('\n\n')
                } catch (err) {
                    return `Gmail list_emails failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gws__read_email: tool({
            description: 'Read the full content of a Gmail message by ID.',
            inputSchema: z.object({
                messageId: z.string().describe('Gmail message ID (from gws__list_emails)'),
            }),
            execute: async ({ messageId }) => {
                try {
                    const res = await fetch(`${GMAIL_BASE}/users/me/messages/${messageId}?format=full`, {
                        headers: getHeaders,
                    })
                    if (!res.ok) return `Gmail error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const msg = await res.json() as {
                        id: string
                        snippet?: string
                        payload?: {
                            headers?: Array<{ name: string; value: string }>
                            body?: { data?: string }
                            parts?: Array<{ mimeType: string; body?: { data?: string } }>
                        }
                    }
                    const hdrs = msg.payload?.headers ?? []
                    const subject = hdrs.find((h) => h.name === 'Subject')?.value ?? '(no subject)'
                    const from = hdrs.find((h) => h.name === 'From')?.value ?? ''
                    const to = hdrs.find((h) => h.name === 'To')?.value ?? ''
                    const date = hdrs.find((h) => h.name === 'Date')?.value ?? ''

                    let body = ''
                    const parts = msg.payload?.parts ?? []
                    const textPart = parts.find((p) => p.mimeType === 'text/plain')
                    if (textPart?.body?.data) {
                        body = Buffer.from(textPart.body.data, 'base64').toString('utf8').slice(0, 4000)
                    } else if (msg.payload?.body?.data) {
                        body = Buffer.from(msg.payload.body.data, 'base64').toString('utf8').slice(0, 4000)
                    } else {
                        body = msg.snippet ?? '(no text content)'
                    }

                    log('gws__read_email', { messageId }, opts)
                    return `Subject: ${subject}\nFrom: ${from}\nTo: ${to}\nDate: ${date}\n\n${body}`
                } catch (err) {
                    return `Gmail read_email failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gws__send_email: tool({
            description:
                "Sends an email via the operator's connected Gmail account. To attach files, populate `attachments`: either reference an existing file by its content-hash (forward-mode — use the contentHash field shown in `conversations.attachments[i].contentHash`), or upload bytes inline as `{filename, mimeType, bytesBase64}` (upload-mode). Limits: 10 files max, 25 MiB total. Infected attachments cannot be forwarded.",
            inputSchema: z.object({
                to: z.string().describe('Recipient email address'),
                subject: z.string().describe('Email subject'),
                body: z.string().describe('Plain text email body'),
                attachments: z
                    .array(
                        z.union([
                            z.object({
                                contentHash: z
                                    .string()
                                    .regex(/^[a-f0-9]{64}$/, '64-char hex sha256'),
                            }),
                            z.object({
                                filename: z.string().min(1).max(255),
                                mimeType: z.string().min(1).max(127),
                                bytesBase64: z
                                    .string()
                                    .max(
                                        Math.ceil((25 * 1024 * 1024 * 4) / 3) + 1024,
                                        'bytesBase64 exceeds 25 MiB raw cap',
                                    ),
                            }),
                        ]),
                    )
                    .max(10)
                    .optional()
                    .describe(
                        'Optional file attachments. Forward-mode: {contentHash} from inbound conversation. Upload-mode: {filename, mimeType, bytesBase64}. Max 10 / 25 MiB total.',
                    ),
            }),
            execute: async ({ to, subject, body, attachments }) => {
                try {
                    const hasAttachments = Array.isArray(attachments) && attachments.length > 0
                    if (!hasAttachments) {
                        const raw = base64url(buildRfc2822(to, subject, body))
                        const res = await fetch(`${GMAIL_BASE}/users/me/messages/send`, {
                            method: 'POST',
                            headers: jsonHeaders,
                            body: JSON.stringify({ raw }),
                        })
                        if (!res.ok) return `Gmail error ${res.status}: ${(await res.text()).slice(0, 200)}`
                        const data = await res.json() as { id: string }
                        log('gws__send_email', { to, subject }, opts)
                        return `Email sent. Message ID: ${data.id}`
                    }

                    const handler = getOutboundAttachmentsHandler()
                    if (!handler) {
                        log('gws__send_email outbound-attachments-handler-missing', { workspaceId: opts.workspaceId }, opts)
                        return 'Gmail send_email failed: outbound attachments not available in this runtime'
                    }

                    const resolved = await handler.resolve(attachments as OutboundAttachmentInput[], {
                        workspaceId: opts.workspaceId,
                    })
                    if (!resolved.ok || !resolved.resolved) {
                        return `Gmail send_email rejected: ${resolved.error ?? 'attachment resolution failed'}`
                    }

                    let fromEmail = (creds.email as string | undefined) ?? ''
                    if (!fromEmail) {
                        try {
                            const profileRes = await fetch(
                                `${GMAIL_BASE}/users/me/profile`,
                                { headers: getHeaders },
                            )
                            if (profileRes.ok) {
                                const profile = (await profileRes.json()) as { emailAddress?: string }
                                fromEmail = profile.emailAddress ?? ''
                            }
                        } catch { /* fall through; build with empty From */ }
                    }

                    const built = buildMime({
                        from: fromEmail,
                        to,
                        subject,
                        bodyText: body,
                        attachments: resolved.resolved.map((r) => ({
                            filename: r.filename,
                            mimeType: r.mimeType,
                            bytes: r.bytes,
                        })),
                    })

                    const raw = base64url(built.raw)
                    const res = await fetch(`${GMAIL_BASE}/users/me/messages/send`, {
                        method: 'POST',
                        headers: jsonHeaders,
                        body: JSON.stringify({ raw }),
                    })
                    if (!res.ok) return `Gmail error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { id: string }

                    // attachment.sent audit links to the originating conversation(s)
                    // for forward-mode attachments via sourceConversationId surfaced
                    // by the resolver. Upload-mode contributes no conversationId.
                    try {
                        const sourceConversationIds = Array.from(
                            new Set(
                                resolved.resolved
                                    .map((r) => r.sourceConversationId)
                                    .filter((id): id is string => typeof id === 'string'),
                            ),
                        )
                        await handler.emitSent({
                            workspaceId: opts.workspaceId,
                            conversationIds: sourceConversationIds,
                            recipientEmail: to,
                            channelType: 'gmail',
                            count: resolved.resolved.length,
                            totalBytes: resolved.resolved.reduce((acc, r) => acc + r.sizeBytes, 0),
                            contentHashes: resolved.resolved
                                .map((r) => r.contentHash)
                                .filter((h): h is string => typeof h === 'string'),
                        })
                    } catch (err) {
                        logger.warn(
                            { err: err instanceof Error ? err.message : String(err) },
                            'gws__send_email: emitSent failed (non-fatal)',
                        )
                    }

                    log(
                        'gws__send_email',
                        { to, subject, attachmentCount: resolved.resolved.length },
                        opts,
                    )
                    return `Email sent with ${resolved.resolved.length} attachment(s). Message ID: ${data.id}`
                } catch (err) {
                    return `Gmail send_email failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        // ── Google Calendar ────────────────────────────────────────────────────

        gws__list_calendars: tool({
            description: 'List all Google Calendars the user has access to, including their IDs, names, and colors. Use this to discover which calendars exist before creating or querying events.',
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const res = await fetch(
                        `${CALENDAR_BASE}/users/me/calendarList`,
                        { headers: getHeaders },
                    )
                    if (!res.ok) return `Calendar error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        items?: Array<{
                            id: string
                            summary?: string
                            summaryOverride?: string
                            primary?: boolean
                            backgroundColor?: string
                            accessRole?: string
                        }>
                    }
                    if (!data.items?.length) return 'No calendars found.'
                    log('gws__list_calendars', { count: data.items.length }, opts)
                    return data.items
                        .map((c) => {
                            const name = c.summaryOverride ?? c.summary ?? '(unnamed)'
                            const primary = c.primary ? ' [PRIMARY]' : ''
                            return `[${c.id}] ${name}${primary} (${c.accessRole ?? 'unknown'})`
                        })
                        .join('\n')
                } catch (err) {
                    return `Calendar list_calendars failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gws__list_events: tool({
            description: 'List upcoming Google Calendar events. Pass calendarId="all" to query ALL accessible calendars at once (recommended when checking a full schedule). Defaults to primary if omitted.',
            inputSchema: z.object({
                calendarId: z.string().optional().default('primary').describe('Calendar ID, or "all" to query every accessible calendar'),
                timeMin: z.string().optional().describe('Start time ISO 8601 (default: now)'),
                timeMax: z.string().optional().describe('End time ISO 8601 (default: 7 days from now)'),
                limit: z.number().optional().default(10),
            }),
            execute: async ({ calendarId = 'primary', timeMin, timeMax, limit = 10 }) => {
                try {
                    const now = new Date()
                    const effectiveTimeMin = timeMin ?? now.toISOString()
                    const effectiveTimeMax = timeMax ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()

                    // Multi-calendar: query all accessible calendars
                    if (calendarId === 'all') {
                        const listRes = await fetch(
                            `${CALENDAR_BASE}/users/me/calendarList`,
                            { headers: getHeaders },
                        )
                        if (!listRes.ok) return `Calendar error ${listRes.status}: ${(await listRes.text()).slice(0, 200)}`
                        const listData = await listRes.json() as {
                            items?: Array<{ id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }>
                        }
                        const calendars = (listData.items ?? []).filter((c) => c.accessRole !== 'freeBusyReader')

                        const allEvents: Array<{ calName: string; id: string; summary: string; start: string; end: string; location?: string }> = []
                        for (const cal of calendars) {
                            const calName = cal.summaryOverride ?? cal.summary ?? '(unnamed)'
                            const params = new URLSearchParams({
                                maxResults: String(Math.min(limit, 50)),
                                singleEvents: 'true',
                                orderBy: 'startTime',
                                timeMin: effectiveTimeMin,
                                timeMax: effectiveTimeMax,
                            })
                            try {
                                const res = await fetch(
                                    `${CALENDAR_BASE}/calendars/${encodeURIComponent(cal.id)}/events?${params}`,
                                    { headers: getHeaders },
                                )
                                if (!res.ok) continue
                                const data = await res.json() as {
                                    items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string }>
                                }
                                for (const e of data.items ?? []) {
                                    allEvents.push({
                                        calName,
                                        id: e.id,
                                        summary: e.summary ?? '(no title)',
                                        start: e.start?.dateTime ?? e.start?.date ?? '',
                                        end: e.end?.dateTime ?? e.end?.date ?? '',
                                        location: e.location,
                                    })
                                }
                            } catch {
                                // Skip inaccessible calendars
                            }
                        }
                        if (!allEvents.length) return 'No events found across any calendar in the given time range.'
                        allEvents.sort((a, b) => a.start.localeCompare(b.start))
                        log('gws__list_events', { calendarId: 'all', count: allEvents.length }, opts)
                        return allEvents
                            .map((e) => `[${e.calName}] ${e.summary} | ${e.start} → ${e.end}${e.location ? ` | ${e.location}` : ''}`)
                            .join('\n')
                    }

                    // Single calendar query (original behavior)
                    const params = new URLSearchParams({
                        maxResults: String(Math.min(limit, 50)),
                        singleEvents: 'true',
                        orderBy: 'startTime',
                        timeMin: effectiveTimeMin,
                        timeMax: effectiveTimeMax,
                    })
                    const res = await fetch(
                        `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
                        { headers: getHeaders },
                    )
                    if (!res.ok) return `Calendar error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        items?: Array<{
                            id: string
                            summary?: string
                            start?: { dateTime?: string; date?: string }
                            end?: { dateTime?: string; date?: string }
                            location?: string
                        }>
                    }
                    if (!data.items?.length) return 'No events found in the given time range.'
                    log('gws__list_events', { calendarId, count: data.items.length }, opts)
                    return data.items
                        .map((e) => {
                            const start = e.start?.dateTime ?? e.start?.date ?? ''
                            const end = e.end?.dateTime ?? e.end?.date ?? ''
                            return `[${e.id}] ${e.summary ?? '(no title)'} | ${start} → ${end}${e.location ? ` | ${e.location}` : ''}`
                        })
                        .join('\n')
                } catch (err) {
                    return `Calendar list_events failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gws__create_event: tool({
            description: 'Create a Google Calendar event.',
            inputSchema: z.object({
                calendarId: z.string().optional().default('primary'),
                title: z.string().describe('Event title'),
                startDateTime: z.string().describe('Start ISO 8601 datetime, e.g. "2026-04-25T10:00:00-05:00"'),
                endDateTime: z.string().describe('End ISO 8601 datetime'),
                description: z.string().optional(),
                location: z.string().optional(),
                attendees: z.array(z.string()).optional().describe('Attendee email addresses'),
            }),
            execute: async ({ calendarId = 'primary', title, startDateTime, endDateTime, description, location, attendees }) => {
                try {
                    const event: Record<string, unknown> = {
                        summary: title,
                        start: { dateTime: startDateTime },
                        end: { dateTime: endDateTime },
                    }
                    if (description) event.description = description
                    if (location) event.location = location
                    if (attendees?.length) event.attendees = attendees.map((email) => ({ email }))
                    const res = await fetch(
                        `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`,
                        { method: 'POST', headers: jsonHeaders, body: JSON.stringify(event) },
                    )
                    if (!res.ok) return `Calendar error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { id: string; htmlLink?: string }
                    log('gws__create_event', { calendarId, title }, opts)
                    return `Event created: ${data.id}${data.htmlLink ? ` — ${data.htmlLink}` : ''}`
                } catch (err) {
                    return `Calendar create_event failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gws__update_event: tool({
            description: 'Update an existing Google Calendar event (fetches current event then applies patches).',
            inputSchema: z.object({
                calendarId: z.string().optional().default('primary'),
                eventId: z.string().describe('Calendar event ID (from gws__list_events)'),
                title: z.string().optional(),
                startDateTime: z.string().optional().describe('New start ISO 8601 datetime'),
                endDateTime: z.string().optional().describe('New end ISO 8601 datetime'),
                description: z.string().optional(),
                location: z.string().optional(),
            }),
            execute: async ({ calendarId = 'primary', eventId, title, startDateTime, endDateTime, description, location }) => {
                try {
                    const getRes = await fetch(
                        `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
                        { headers: getHeaders },
                    )
                    if (!getRes.ok) return `Calendar error ${getRes.status}: ${(await getRes.text()).slice(0, 200)}`
                    const existing = await getRes.json() as Record<string, unknown>

                    if (title) existing.summary = title
                    if (startDateTime) existing.start = { dateTime: startDateTime }
                    if (endDateTime) existing.end = { dateTime: endDateTime }
                    if (description !== undefined) existing.description = description
                    if (location !== undefined) existing.location = location

                    const res = await fetch(
                        `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
                        { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(existing) },
                    )
                    if (!res.ok) return `Calendar error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    log('gws__update_event', { calendarId, eventId }, opts)
                    return `Event ${eventId} updated.`
                } catch (err) {
                    return `Calendar update_event failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gws__delete_event: tool({
            description: 'Delete a Google Calendar event.',
            inputSchema: z.object({
                calendarId: z.string().optional().default('primary'),
                eventId: z.string().describe('Calendar event ID'),
            }),
            execute: async ({ calendarId = 'primary', eventId }) => {
                try {
                    const res = await fetch(
                        `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
                        { method: 'DELETE', headers: getHeaders },
                    )
                    if (!res.ok && res.status !== 204) {
                        return `Calendar error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    }
                    log('gws__delete_event', { calendarId, eventId }, opts)
                    return `Event ${eventId} deleted.`
                } catch (err) {
                    return `Calendar delete_event failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        // ── Google Drive ───────────────────────────────────────────────────────

        gws__search_drive: tool({
            description: 'Search Google Drive for files by name or content.',
            inputSchema: z.object({
                query: z.string().describe('Search text — matches file names and full-text content'),
                mimeType: z.string().optional().describe('Optional MIME type filter, e.g. "application/vnd.google-apps.document"'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ query, mimeType, limit = 20 }) => {
                try {
                    const qParts = [
                        `(name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}')`,
                        'trashed = false',
                    ]
                    if (mimeType) qParts.push(`mimeType = '${mimeType}'`)
                    const q = qParts.join(' and ')
                    const url = `${DRIVE_BASE}/files?q=${encodeURIComponent(q)}&pageSize=${Math.min(limit, 100)}&fields=files(id,name,mimeType,webViewLink,modifiedTime)`
                    const res = await fetch(url, { headers: getHeaders })
                    if (!res.ok) return `Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        files: Array<{ id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string }>
                    }
                    if (!data.files.length) return 'No files found.'
                    log('gws__search_drive', { query, count: data.files.length }, opts)
                    return data.files
                        .map((f) => `${f.name} [${f.mimeType}] — ${f.id}${f.webViewLink ? ` — ${f.webViewLink}` : ''}`)
                        .join('\n')
                } catch (err) {
                    return `Drive search failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gws__get_file: tool({
            description: 'Get Google Drive file metadata, or export the text content of a Google Doc/Sheet.',
            inputSchema: z.object({
                fileId: z.string().describe('Google Drive file ID'),
            }),
            execute: async ({ fileId }) => {
                try {
                    const metaRes = await fetch(
                        `${DRIVE_BASE}/files/${fileId}?fields=id,name,mimeType,webViewLink,modifiedTime,size`,
                        { headers: getHeaders },
                    )
                    if (!metaRes.ok) return `Drive error ${metaRes.status}: ${(await metaRes.text()).slice(0, 200)}`
                    const meta = await metaRes.json() as {
                        id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string; size?: string
                    }

                    let content = ''
                    if (meta.mimeType === 'application/vnd.google-apps.document') {
                        const exportRes = await fetch(`${DRIVE_BASE}/files/${fileId}/export?mimeType=text/plain`, { headers: getHeaders })
                        if (exportRes.ok) content = (await exportRes.text()).slice(0, 5000)
                    } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
                        const exportRes = await fetch(`${DRIVE_BASE}/files/${fileId}/export?mimeType=text/csv`, { headers: getHeaders })
                        if (exportRes.ok) content = (await exportRes.text()).slice(0, 5000)
                    }

                    log('gws__get_file', { fileId, mimeType: meta.mimeType }, opts)
                    const lines = [
                        `Name: ${meta.name}`,
                        `Type: ${meta.mimeType}`,
                        meta.size ? `Size: ${meta.size} bytes` : '',
                        meta.modifiedTime ? `Modified: ${meta.modifiedTime}` : '',
                        meta.webViewLink ? `URL: ${meta.webViewLink}` : '',
                    ].filter(Boolean)
                    return content ? `${lines.join('\n')}\n\n--- Content ---\n${content}` : lines.join('\n')
                } catch (err) {
                    return `Drive get_file failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gws__create_file: tool({
            description: 'Create a text file or Google Doc in Google Drive.',
            inputSchema: z.object({
                name: z.string().describe('File name'),
                content: z.string().describe('File text content'),
                mimeType: z.string().optional().default('text/plain').describe('MIME type — use "application/vnd.google-apps.document" for a Google Doc'),
                parentFolderId: z.string().optional().describe('Parent folder ID (omit for root)'),
            }),
            execute: async ({ name, content, mimeType = 'text/plain', parentFolderId }) => {
                try {
                    const metadata: Record<string, unknown> = { name, mimeType }
                    if (parentFolderId) metadata.parents = [parentFolderId]

                    const boundary = 'plexo-gws-' + Math.random().toString(36).slice(2)
                    const delimiter = `\r\n--${boundary}\r\n`
                    const closeDelim = `\r\n--${boundary}--`
                    const uploadBody =
                        delimiter +
                        'Content-Type: application/json\r\n\r\n' +
                        JSON.stringify(metadata) +
                        delimiter +
                        `Content-Type: ${mimeType === 'application/vnd.google-apps.document' ? 'text/plain' : mimeType}\r\n\r\n` +
                        content +
                        closeDelim

                    const res = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`, {
                        method: 'POST',
                        headers: {
                            Authorization: auth,
                            'Content-Type': `multipart/related; boundary=${boundary}`,
                        },
                        body: uploadBody,
                    })
                    if (!res.ok) return `Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { id: string; name: string; webViewLink?: string }
                    log('gws__create_file', { fileId: data.id, mimeType }, opts)
                    return `Created "${data.name}" — ${data.id}${data.webViewLink ? ` — ${data.webViewLink}` : ''}`
                } catch (err) {
                    return `Drive create_file failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}
