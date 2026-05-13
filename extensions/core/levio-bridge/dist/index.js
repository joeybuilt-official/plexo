// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// @joeybuilt/levio-bridge — Pex tool extension that proxies tool calls to
// Levio's /api/plexo/data endpoint. Interim bridge until Pex v0.5.0 ships
// native remote tool support. See ADR-0001 for rationale.
// ── Config ──────────────────────────────────────────────────────────────────
function levioBase() {
    return (process.env.LEVIO_INTERNAL_URL ?? 'http://service:3000').replace(/\/$/, '');
}
function serviceHeaders() {
    return {
        Authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY ?? ''}`,
        'Content-Type': 'application/json',
    };
}
const TIMEOUT_MS = 10_000;
// Cached at activation time from extension settings so every tool call
// auto-authenticates without the AI needing to supply userId explicitly.
let _cachedUserId = null;
function resolveUserId(params) {
    const uid = params.userId || _cachedUserId || '';
    if (!uid)
        throw new Error('No Levio user ID available. Connect Levio in Settings > Integrations.');
    return uid;
}
// ── Helpers ─────────────────────────────────────────────────────────────────
async function levioGet(params) {
    const res = await fetch(`${levioBase()}/api/plexo/data?${params}`, {
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Levio API error ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
}
async function levioPost(body) {
    const res = await fetch(`${levioBase()}/api/plexo/data`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Levio API error ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    return res.json();
}
// ── Tool Definitions ────────────────────────────────────────────────────────
function emailSearchTool() {
    return {
        name: 'levio.email.search',
        description: 'Search emails in the user\'s Levio account. Returns subject, sender, AI category, and summary. ' +
            'Categories: action (needs response/action), fyi (informational), waiting (awaiting reply), ' +
            'delegate (needs someone else), archive (done). Default returns all non-archived emails.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
                category: {
                    type: 'string',
                    enum: ['action', 'fyi', 'waiting', 'delegate', 'archive', 'all'],
                    description: 'Filter by AI category. Omit for all non-archived emails.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max emails to return (max 100, default 20).',
                },
            },
            required: [],
        },
        hints: {
            estimatedMs: 3000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: false,
            idempotent: true,
        },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const { category, limit = 20 } = p;
            const qp = new URLSearchParams({ entity: 'email', userId, limit: String(limit) });
            if (category)
                qp.set('category', category);
            const data = await levioGet(qp);
            if (!data.emails?.length)
                return 'No emails found.';
            return data.emails.map((e) => `[${e.aiCategory ?? 'uncategorized'}] ${e.subject ?? '(no subject)'}\n` +
                `  From: ${e.senderName ?? ''} <${e.senderEmail ?? ''}> | ${e.receivedAt ? new Date(e.receivedAt).toLocaleString() : ''}\n` +
                `  ${e.aiSummary ?? ''}`).join('\n\n');
        },
    };
}
function emailSendTool() {
    return {
        name: 'levio.email.send',
        description: 'Send an email through the user\'s connected Levio email account. ' +
            'Requires escalation approval before execution.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
                to: {
                    type: 'string',
                    description: 'Recipient email address.',
                },
                subject: {
                    type: 'string',
                    description: 'Email subject line.',
                },
                body: {
                    type: 'string',
                    description: 'Email body text.',
                },
                replyToId: {
                    type: 'string',
                    description: 'Email ID to reply to (for threading). Omit for new emails.',
                },
            },
            required: ['to', 'subject', 'body'],
        },
        hints: {
            estimatedMs: 5000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: true,
            idempotent: false,
        },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const { to, subject, body, replyToId } = p;
            const data = await levioPost({
                entity: 'email',
                action: 'send',
                userId,
                to,
                subject,
                body,
                replyToId,
            });
            return `Email sent to ${to}: "${subject}" (ID: ${data.messageId ?? 'unknown'})`;
        },
    };
}
function emailSummarizeTodayTool() {
    return {
        name: 'levio.email.summarize_today',
        description: 'Get an AI-generated summary of today\'s emails from the user\'s Levio account. ' +
            'Returns categorized overview with action items highlighted.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
            },
            required: [],
        },
        hints: {
            estimatedMs: 4000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: false,
            idempotent: true,
        },
        handler: async (params, _ctx) => {
            const userId = resolveUserId(params);
            const today = new Date().toISOString().slice(0, 10);
            const qp = new URLSearchParams({
                entity: 'email',
                userId,
                limit: '50',
                since: today,
            });
            const data = await levioGet(qp);
            if (!data.emails?.length)
                return 'No emails received today.';
            const byCategory = {};
            for (const e of data.emails) {
                const cat = e.aiCategory ?? 'uncategorized';
                if (!byCategory[cat])
                    byCategory[cat] = [];
                byCategory[cat].push(`- ${e.subject ?? '(no subject)'} from ${e.senderName ?? 'unknown'}: ${e.aiSummary ?? ''}`);
            }
            const lines = [`Today's emails (${data.total} total):`];
            for (const [cat, items] of Object.entries(byCategory)) {
                lines.push(`\n[${cat.toUpperCase()}] (${items.length})`);
                lines.push(...items);
            }
            return lines.join('\n');
        },
    };
}
function calendarListTool() {
    return {
        name: 'levio.calendar.list',
        description: 'List calendar events from the user\'s connected Levio account. Defaults to the next 7 days.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
                date: {
                    type: 'string',
                    description: 'Specific date YYYY-MM-DD to get events for.',
                },
                start: {
                    type: 'string',
                    description: 'Start of date range (ISO 8601).',
                },
                end: {
                    type: 'string',
                    description: 'End of date range (ISO 8601).',
                },
            },
            required: [],
        },
        hints: {
            estimatedMs: 3000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: false,
            idempotent: true,
        },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const { date, start, end } = p;
            const qp = new URLSearchParams({ entity: 'calendar', userId });
            if (date)
                qp.set('date', date);
            if (start)
                qp.set('start', start);
            if (end)
                qp.set('end', end);
            const data = await levioGet(qp);
            if (!data.events?.length)
                return 'No calendar events found in the given range.';
            return data.events.map((e) => {
                const s = e.startAt ? new Date(e.startAt).toLocaleString() : '?';
                const en = e.endAt ? new Date(e.endAt).toLocaleString() : '?';
                const attendeeCount = Array.isArray(e.attendees) ? e.attendees.length : 0;
                return `${e.title ?? '(untitled)'} | ${s} -> ${en}` +
                    (e.location ? ` | ${e.location}` : '') +
                    (attendeeCount > 0 ? ` | ${attendeeCount} attendees` : '');
            }).join('\n');
        },
    };
}
function calendarListSourcesTool() {
    return {
        name: 'levio.calendar.list_sources',
        description: 'List the calendars available on the user\'s connected Levio account ' +
            '(e.g. Personal, Family, Work). Returns each calendar\'s name, providerId, ' +
            'color, and primary/enabled flags. Call this before creating an event so ' +
            'you know which calendar to target; pass the chosen providerId as ' +
            'calendarId to levio.calendar.create_event.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
            },
            required: [],
        },
        hints: {
            estimatedMs: 2000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: false,
            idempotent: true,
        },
        handler: async (params, _ctx) => {
            const userId = resolveUserId(params);
            const qp = new URLSearchParams({ entity: 'calendar_sources', userId });
            const data = await levioGet(qp);
            if (!data.sources?.length)
                return 'No calendars found. The user may not have a calendar provider connected.';
            return data.sources.map((s) => `- ${s.name}${s.isPrimary ? ' (primary)' : ''}${s.enabled ? '' : ' [disabled]'} — calendarId: ${s.providerId}`).join('\n');
        },
    };
}
function calendarCreateEventTool() {
    return {
        name: 'levio.calendar.create_event',
        description: 'Create a calendar event in the user\'s connected Levio account. ' +
            'When the user specifies a calendar (e.g., "my family calendar"), use ' +
            'levio.calendar.list_sources first to find the calendarId, then pass it here. ' +
            'Defaults to the user\'s primary calendar when calendarId is omitted. ' +
            'For recurring events, use standard RRULE format in the recurrence parameter: ' +
            'RRULE:FREQ=WEEKLY;BYDAY=WE for every Wednesday, RRULE:FREQ=DAILY for daily, etc.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
                title: {
                    type: 'string',
                    description: 'Event title.',
                },
                startAt: {
                    type: 'string',
                    description: 'Event start time (ISO 8601).',
                },
                endAt: {
                    type: 'string',
                    description: 'Event end time (ISO 8601).',
                },
                calendarId: {
                    type: 'string',
                    description: 'Calendar to create on — the providerId from levio.calendar.list_sources (e.g. "family@group.calendar.google.com"). Defaults to the primary calendar when omitted.',
                },
                recurrence: {
                    type: 'string',
                    description: 'RRULE string for recurring events (e.g. "RRULE:FREQ=WEEKLY;BYDAY=WE" for every Wednesday, "RRULE:FREQ=DAILY" for daily, "RRULE:FREQ=MONTHLY;BYMONTHDAY=1" for 1st of each month).',
                },
                location: {
                    type: 'string',
                    description: 'Event location (optional).',
                },
                description: {
                    type: 'string',
                    description: 'Event description (optional).',
                },
            },
            required: ['title', 'startAt', 'endAt'],
        },
        hints: {
            estimatedMs: 5000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: true,
            idempotent: false,
        },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const { title, startAt, endAt, calendarId, recurrence, location, description } = p;
            const data = await levioPost({
                entity: 'calendar',
                action: 'create',
                userId,
                title,
                startAt,
                endAt,
                calendarId,
                recurrence,
                location,
                description,
            });
            return `Event created: "${data.event?.title ?? title}" (ID: ${data.event?.id ?? 'unknown'})`;
        },
    };
}
function calendarUpdateEventTool() {
    return {
        name: 'levio.calendar.update_event',
        description: 'Update an existing calendar event in the user\'s connected Levio account.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
                eventId: {
                    type: 'string',
                    description: 'ID of the event to update.',
                },
                title: {
                    type: 'string',
                    description: 'Updated event title.',
                },
                startAt: {
                    type: 'string',
                    description: 'Updated start time (ISO 8601).',
                },
                endAt: {
                    type: 'string',
                    description: 'Updated end time (ISO 8601).',
                },
                location: {
                    type: 'string',
                    description: 'Updated location.',
                },
            },
            required: ['eventId'],
        },
        hints: {
            estimatedMs: 5000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: true,
            idempotent: true,
        },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const { eventId, title, startAt, endAt, location } = p;
            const updates = {};
            if (title !== undefined)
                updates.title = title;
            if (startAt !== undefined)
                updates.startAt = startAt;
            if (endAt !== undefined)
                updates.endAt = endAt;
            if (location !== undefined)
                updates.location = location;
            const data = await levioPost({
                entity: 'calendar',
                action: 'update',
                userId,
                eventId,
                ...updates,
            });
            return `Event updated: "${data.event?.title ?? 'unknown'}" (ID: ${eventId})`;
        },
    };
}
function tasksListTool() {
    return {
        name: 'levio.tasks.list',
        description: 'List tasks from the user\'s Levio account. Returns title, status, priority, and due date.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
                status: {
                    type: 'string',
                    enum: ['inbox', 'scheduled', 'done', 'someday'],
                    description: 'Filter by task status. Omit for all non-done tasks.',
                },
                limit: {
                    type: 'integer',
                    description: 'Max tasks to return (default 30).',
                },
            },
            required: [],
        },
        hints: {
            estimatedMs: 3000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: false,
            idempotent: true,
        },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const { status, limit = 30 } = p;
            const qp = new URLSearchParams({ entity: 'task', userId, limit: String(limit) });
            if (status)
                qp.set('status', status);
            const data = await levioGet(qp);
            if (!data.tasks?.length)
                return 'No tasks found.';
            return data.tasks.map((t) => `[${t.status}] ${t.title}` +
                (t.priority ? ` (${t.priority})` : '') +
                (t.dueDate ? ` -- due ${t.dueDate}` : '')).join('\n');
        },
    };
}
function tasksCreateTool() {
    return {
        name: 'levio.tasks.create',
        description: 'Create a task in the user\'s Levio account.',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
                title: {
                    type: 'string',
                    description: 'Task title.',
                },
                priority: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'Task priority.',
                },
                dueDate: {
                    type: 'string',
                    description: 'Due date YYYY-MM-DD.',
                },
            },
            required: ['title'],
        },
        hints: {
            estimatedMs: 3000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: true,
            idempotent: false,
        },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const { title, priority, dueDate } = p;
            const data = await levioPost({
                entity: 'task',
                userId,
                title,
                priority,
                dueDate,
            });
            return `Task created: "${data.task?.title ?? title}" (ID: ${data.task?.id ?? 'unknown'})`;
        },
    };
}
function tasksUpdateTool() {
    return {
        name: 'levio.tasks.update',
        description: 'Update an existing task in the user\'s Levio account (status, title, priority, due date).',
        parameters: {
            type: 'object',
            properties: {
                userId: {
                    type: 'string',
                    description: 'Levio user ID (auto-resolved from connection, rarely needed).',
                },
                taskId: {
                    type: 'string',
                    description: 'ID of the task to update.',
                },
                title: {
                    type: 'string',
                    description: 'Updated task title.',
                },
                status: {
                    type: 'string',
                    enum: ['inbox', 'scheduled', 'done', 'someday'],
                    description: 'Updated task status.',
                },
                priority: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'Updated task priority.',
                },
                dueDate: {
                    type: 'string',
                    description: 'Updated due date YYYY-MM-DD.',
                },
            },
            required: ['taskId'],
        },
        hints: {
            estimatedMs: 3000,
            timeoutMs: TIMEOUT_MS,
            hasSideEffects: true,
            idempotent: true,
        },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const { taskId, title, status, priority, dueDate } = p;
            const updates = {};
            if (title !== undefined)
                updates.title = title;
            if (status !== undefined)
                updates.status = status;
            if (priority !== undefined)
                updates.priority = priority;
            if (dueDate !== undefined)
                updates.dueDate = dueDate;
            const data = await levioPost({
                entity: 'task',
                action: 'update',
                userId,
                taskId,
                ...updates,
            });
            return `Task updated: "${data.task?.title ?? 'unknown'}" (ID: ${taskId})`;
        },
    };
}
// ── Synthesis Phase 5 — promotion event subscription ────────────────────────
// When Plexo's synthesis loop decides a suggestion should become a Levio
// task (note → imperative language), it publishes
// `ext.synthesis-promote.levio.tasks.create` on the PEX event-bus. We
// subscribe here and POST to Levio's data API. Auto-resolved userId
// (extension activation pattern, commit 516dab8) means no manual setup.
async function handlePromotionToTask(payload) {
    if (!payload || typeof payload !== 'object')
        return;
    const p = payload;
    const inner = (p.payload && typeof p.payload === 'object') ? p.payload : {};
    const title = typeof inner.title === 'string' ? inner.title : null;
    const userId = _cachedUserId;
    if (!userId || !title)
        return;
    try {
        await levioPost({
            entity: 'task',
            userId,
            title,
            priority: typeof inner.priority === 'string' ? inner.priority : 'medium',
            dueDate: typeof inner.dueDate === 'string' ? inner.dueDate : undefined,
            source: 'plexo.synthesis',
            sourceId: p.suggestionId,
        });
    }
    catch {
        // Promotion failures are non-fatal; the suggestion is already
        // marked promoted upstream so we don't loop. Caller logs.
    }
}
// ── Activation ──────────────────────────────────────────────────────────────
export async function activate(sdk) {
    // Resolve levio_user_id from extension settings so tools auto-authenticate
    // without the AI needing to supply userId on every call.
    try {
        _cachedUserId = await sdk.storage.get('levio_user_id');
    }
    catch {
        // storage:read may fail in test/bootstrap -- tools will fall back
        // to requiring userId as an explicit parameter.
    }
    sdk.registerTool(emailSearchTool());
    sdk.registerTool(emailSendTool());
    sdk.registerTool(emailSummarizeTodayTool());
    sdk.registerTool(calendarListTool());
    sdk.registerTool(calendarListSourcesTool());
    sdk.registerTool(calendarCreateEventTool());
    sdk.registerTool(calendarUpdateEventTool());
    sdk.registerTool(tasksListTool());
    sdk.registerTool(tasksCreateTool());
    sdk.registerTool(tasksUpdateTool());
    // Phase 5 — synthesis cross-app promotion subscriber
    try {
        sdk.events.subscribe('ext.synthesis-promote.levio.tasks.create', (payload) => {
            void handlePromotionToTask(payload);
        });
    }
    catch {
        // events:subscribe may not be granted in some workspace configs —
        // promotion is opt-in, so degrade gracefully.
    }
}
