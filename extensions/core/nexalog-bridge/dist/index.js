// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// @joeybuilt/nexalog-bridge — Pex tool extension that proxies tool calls to
// Nexalog's /api/plexo/data endpoint. Mirrors @joeybuilt/levio-bridge.
import { readFile } from 'node:fs/promises';
function nexalogBase() {
    return (process.env.NEXALOG_INTERNAL_URL ?? 'http://service:3300').replace(/\/$/, '');
}
function serviceHeaders() {
    return {
        Authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY ?? ''}`,
        'Content-Type': 'application/json',
    };
}
const TIMEOUT_MS = 10_000;
let _cachedUserId = null;
function resolveUserId(params) {
    const uid = params.userId || _cachedUserId || '';
    if (!uid)
        throw new Error('No Nexalog user ID available. Connect Nexalog in Settings > Integrations.');
    return uid;
}
async function nexalogGet(params) {
    const res = await fetch(`${nexalogBase()}/api/plexo/data?${params}`, {
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Nexalog API error ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
}
async function nexalogPost(body) {
    const res = await fetch(`${nexalogBase()}/api/plexo/data`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Nexalog API error ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    return res.json();
}
function noteListTool() {
    return {
        name: 'nexalog.note.list',
        description: "List active notes in the user's Nexalog workspaces. Returns ID, title, kind, and updated time.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved from connection).' },
                limit: { type: 'number', description: 'Max results (1-100, default 30).' },
            },
            required: [],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'note', userId });
            if (p.limit)
                qp.set('limit', String(p.limit));
            const data = await nexalogGet(qp);
            if (!data.notes?.length)
                return 'No notes found.';
            return [`${data.total} notes:`, ...data.notes.map((n) => `- ${n.id} | ${n.title || '(untitled)'}${n.kind && n.kind !== 'note' ? ` [${n.kind}]` : ''}`)].join('\n');
        },
    };
}
function noteSearchTool() {
    return {
        name: 'nexalog.note.search',
        description: 'Full-text search across note titles and content.',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                q: { type: 'string', description: 'Search query.' },
                limit: { type: 'number', description: 'Max results (1-50, default 20).' },
            },
            required: ['q'],
        },
        hints: { estimatedMs: 2000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'note_search', userId, q: p.q });
            if (p.limit)
                qp.set('limit', String(p.limit));
            const data = await nexalogGet(qp);
            if (!data.notes?.length)
                return `No matches for "${p.q}".`;
            return [`${data.total} matches for "${p.q}":`, ...data.notes.map((n) => `- ${n.id} | ${n.title || '(untitled)'}${n.kind && n.kind !== 'note' ? ` [${n.kind}]` : ''}`)].join('\n');
        },
    };
}
function noteGetTool() {
    return {
        name: 'nexalog.note.get',
        description: "Fetch the full content of a single note by ID.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Note UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'note', userId, id: p.id });
            const data = await nexalogGet(qp);
            const n = data.note;
            return [`# ${n.title || '(untitled)'}`, `ID: ${n.id}${n.kind && n.kind !== 'note' ? ` | Kind: ${n.kind}` : ''}`, '', n.content || '(no content)'].join('\n');
        },
    };
}
function noteCreateTool() {
    return {
        name: 'nexalog.note.create',
        description: "Create a new text note in the user's Nexalog workspace. For saving URLs or web pages, use bookmark.add instead.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                title: { type: 'string', description: 'Note title.' },
                content: { type: 'string', description: 'Note body (plain text or HTML).' },
                kind: { type: 'string', description: 'Note kind (note, log, journal, etc.).' },
            },
            required: ['title'],
        },
        hints: { estimatedMs: 2000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await nexalogPost({ entity: 'note', action: 'create', userId, title: p.title, content: p.content, kind: p.kind });
            return `Note created: ${data.note.title} (ID: ${data.note.id})`;
        },
    };
}
function noteUpdateTool() {
    return {
        name: 'nexalog.note.update',
        description: "Update the title or content of an existing note. Use nexalog.note.get to retrieve current content first.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Note UUID.' },
                title: { type: 'string', description: 'New title (omit to leave unchanged).' },
                content: { type: 'string', description: 'New content (omit to leave unchanged).' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await nexalogPost({ entity: 'note', action: 'update', userId, id: p.id, title: p.title, content: p.content });
            return `Note updated: ${data.note.title} (ID: ${data.note.id})`;
        },
    };
}
function noteDeleteTool() {
    return {
        name: 'nexalog.note.delete',
        description: "Soft-delete a note by ID. It will no longer appear in listings.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Note UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await nexalogPost({ entity: 'note', action: 'delete', userId, id: p.id });
            return `Note deleted: ${data.note.title} (ID: ${data.note.id})`;
        },
    };
}
function bookmarkListTool() {
    return {
        name: 'nexalog.bookmark.list',
        description: "List saved URL bookmarks in the user's Nexalog workspace.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved from connection).' },
                limit: { type: 'number', description: 'Max results (1-100, default 30).' },
            },
            required: [],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'capture_source', userId, kind: 'url' });
            if (p.limit)
                qp.set('limit', String(p.limit));
            const data = await nexalogGet(qp);
            if (!data.sources?.length)
                return 'No bookmarks saved.';
            return [`${data.total} bookmarks:`, ...data.sources.map((s) => {
                    const parts = [`- ${s.id} | ${s.ogTitle || s.url || '(no url)'}`];
                    if (s.ogImage)
                        parts.push(`  thumbnail: ${s.ogImage}`);
                    else if (s.faviconUrl)
                        parts.push(`  favicon: ${s.faviconUrl}`);
                    return parts.join('\n');
                })].join('\n');
        },
    };
}
function bookmarkAddTool() {
    return {
        name: 'nexalog.bookmark.add',
        description: "Save a URL as a bookmark in the user's Nexalog workspace. Use this for web pages, links, and URLs — NOT note.create.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                url: { type: 'string', description: 'The URL to bookmark.' },
                title: { type: 'string', description: 'Optional display title for the bookmark.' },
            },
            required: ['url'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await nexalogPost({ entity: 'capture_source', action: 'create', userId, kind: 'url', url: p.url, content: p.title ?? '' });
            return `Bookmark saved: ${p.url} (ID: ${data.source.id})`;
        },
    };
}
function bookmarkGetTool() {
    return {
        name: 'nexalog.bookmark.get',
        description: "Fetch the full details of a single bookmark by ID.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Bookmark (capture source) UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'capture_source', userId, id: p.id });
            const data = await nexalogGet(qp);
            const s = data.source;
            const lines = [`# ${s.ogTitle || s.url || '(no title)'}`, `ID: ${s.id}`, `URL: ${s.url || '(none)'}`, `State: ${s.state}`];
            if (s.ogImage)
                lines.push(`Thumbnail: ${s.ogImage}`);
            if (s.faviconUrl)
                lines.push(`Favicon: ${s.faviconUrl}`);
            return lines.join('\n');
        },
    };
}
function bookmarkUpdateTool() {
    return {
        name: 'nexalog.bookmark.update',
        description: "Update the URL or title of an existing bookmark.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Bookmark (capture source) UUID.' },
                url: { type: 'string', description: 'New URL (omit to leave unchanged).' },
                title: { type: 'string', description: 'New display title (omit to leave unchanged).' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await nexalogPost({ entity: 'capture_source', action: 'update', userId, id: p.id, url: p.url, content: p.title });
            return `Bookmark updated (ID: ${data.source.id})`;
        },
    };
}
function bookmarkDeleteTool() {
    return {
        name: 'nexalog.bookmark.delete',
        description: "Delete a saved bookmark by ID. Use nexalog.bookmark.list to find IDs.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Bookmark (capture source) UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await nexalogPost({ entity: 'capture_source', action: 'delete', userId, id: p.id });
            return `Bookmark deleted (ID: ${p.id})`;
        },
    };
}
function captureListTool() {
    return {
        name: 'nexalog.capture.list',
        description: "List capture sources (raw inbox of links, snippets, ingested logs) in the user's Nexalog workspace.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                state: { type: 'string', description: 'Filter by state (raw, processed, archived).' },
                limit: { type: 'number', description: 'Max results (1-100, default 30).' },
            },
            required: [],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'capture_source', userId });
            if (p.state)
                qp.set('state', p.state);
            if (p.limit)
                qp.set('limit', String(p.limit));
            const data = await nexalogGet(qp);
            if (!data.sources?.length)
                return 'No capture sources.';
            return [`${data.total} captures:`, ...data.sources.map((s) => `- ${s.id} | [${s.state}] ${s.kind}${s.url ? ` ${s.url}` : ''}`)].join('\n');
        },
    };
}
function memoCreateTool() {
    return {
        name: 'nexalog.memo.create',
        description: "Save a voice memo transcript as a note in the user's Nexalog workspace. Use this after transcribing voice recordings or when the user asks to save a memo.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                content: { type: 'string', description: 'Transcript or memo body.' },
                title: { type: 'string', description: 'Optional memo title. Defaults to a timestamp-based title if omitted.' },
            },
            required: ['content'],
        },
        hints: { estimatedMs: 2000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const title = p.title || `Voice memo ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
            const data = await nexalogPost({ entity: 'note', action: 'create', userId, title, content: p.content, kind: 'voice_memo' });
            return `Memo saved: ${data.note.title} (ID: ${data.note.id})`;
        },
    };
}
function captureGetTool() {
    return {
        name: 'nexalog.capture.get',
        description: "Fetch full details of a single capture source by ID.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Capture source UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'capture_source', userId, id: p.id });
            const data = await nexalogGet(qp);
            const s = data.source;
            const lines = [
                `ID: ${s.id} | Kind: ${s.kind} | State: ${s.state}`,
                s.url ? `URL: ${s.url}` : '',
                s.ogTitle ? `Title: ${s.ogTitle}` : '',
                s.ogDescription ? `Description: ${s.ogDescription}` : '',
                s.content ? `Content: ${s.content.slice(0, 300)}${s.content.length > 300 ? '…' : ''}` : '',
                s.ogImage ? `Thumbnail: ${s.ogImage}` : '',
                s.faviconUrl ? `Favicon: ${s.faviconUrl}` : '',
                s.noteId ? `Linked note: ${s.noteId}` : '',
            ].filter(Boolean);
            return lines.join('\n');
        },
    };
}
function captureUpdateTool() {
    return {
        name: 'nexalog.capture.update',
        description: "Update the state or content of a capture source. Use this to mark captures as processed or archived.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Capture source UUID.' },
                state: { type: 'string', description: 'New state: raw, processed, or archived.' },
                content: { type: 'string', description: 'Updated content (omit to leave unchanged).' },
                url: { type: 'string', description: 'Updated URL (omit to leave unchanged).' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await nexalogPost({ entity: 'capture_source', action: 'update', userId, id: p.id, state: p.state, content: p.content, url: p.url });
            return `Capture updated: state=${data.source.state} (ID: ${data.source.id})`;
        },
    };
}
function captureDeleteTool() {
    return {
        name: 'nexalog.capture.delete',
        description: "Delete a capture source by ID. Use nexalog.capture.list to find IDs.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                id: { type: 'string', description: 'Capture source UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await nexalogPost({ entity: 'capture_source', action: 'delete', userId, id: p.id });
            return `Capture deleted (ID: ${p.id})`;
        },
    };
}
function captureCreateTool() {
    return {
        name: 'nexalog.capture.create',
        description: "Create a new capture source (link, snippet, or log entry) in the user's Nexalog workspace.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                kind: { type: 'string', description: 'Source kind (url, snippet, log, etc.).' },
                content: { type: 'string', description: 'Captured content.' },
                url: { type: 'string', description: 'Source URL (if kind=url).' },
            },
            required: ['kind'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await nexalogPost({ entity: 'capture_source', action: 'create', userId, kind: p.kind, content: p.content, url: p.url });
            return `Capture created: ${data.source.kind} (ID: ${data.source.id})`;
        },
    };
}
function bookmarkTagsListTool() {
    return {
        name: 'nexalog.bookmark.tags.list',
        description: "List all bookmark tags in the user's Nexalog workspace. Returns tag IDs, names, and colors.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
            },
            required: [],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'bookmark_tag', userId });
            const data = await nexalogGet(qp);
            if (!data.tags?.length)
                return 'No tags defined.';
            return [`${data.total} tags:`, ...data.tags.map((t) => `- ${t.id} | ${t.name} (${t.color})`)].join('\n');
        },
    };
}
function bookmarkTagCreateTool() {
    return {
        name: 'nexalog.bookmark.tag.create',
        description: "Create a new bookmark tag in the user's Nexalog workspace.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                name: { type: 'string', description: 'Tag name (lowercase, max 50 chars).' },
                color: { type: 'string', description: 'Hex color code (e.g. #6366f1).' },
            },
            required: ['name'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await nexalogPost({ entity: 'bookmark_tag', action: 'create', userId, name: p.name, color: p.color });
            return `Tag created: ${data.tag.name} (ID: ${data.tag.id})`;
        },
    };
}
function bookmarkTagAssignTool() {
    return {
        name: 'nexalog.bookmark.tag.assign',
        description: "Assign a tag to a bookmark (capture source). Use nexalog.bookmark.tags.list to get tag IDs.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                captureSourceId: { type: 'string', description: 'Bookmark (capture source) UUID.' },
                tagId: { type: 'string', description: 'Tag UUID.' },
            },
            required: ['captureSourceId', 'tagId'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await nexalogPost({ entity: 'bookmark_tag', action: 'assign', userId, captureSourceId: p.captureSourceId, tagId: p.tagId });
            return `Tag assigned (capture: ${p.captureSourceId}, tag: ${p.tagId})`;
        },
    };
}
function bookmarkTagRemoveTool() {
    return {
        name: 'nexalog.bookmark.tag.remove',
        description: "Remove a tag from a bookmark (capture source).",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                captureSourceId: { type: 'string', description: 'Bookmark (capture source) UUID.' },
                tagId: { type: 'string', description: 'Tag UUID to remove.' },
            },
            required: ['captureSourceId', 'tagId'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await nexalogPost({ entity: 'bookmark_tag', action: 'unassign', userId, captureSourceId: p.captureSourceId, tagId: p.tagId });
            return `Tag removed (capture: ${p.captureSourceId}, tag: ${p.tagId})`;
        },
    };
}
// ── Claude format helpers ────────────────────────────────────────────────────
function linearizeMessages(messages, leafUuid) {
    if (!messages?.length)
        return [];
    const sorted = [...messages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (!leafUuid)
        return sorted;
    const byUuid = new Map(messages.map(m => [m.uuid, m]));
    if (!byUuid.has(leafUuid))
        return sorted;
    const path = [];
    let cur = byUuid.get(leafUuid);
    while (cur) {
        path.unshift(cur);
        cur = cur.parent_message_uuid ? byUuid.get(cur.parent_message_uuid) : undefined;
    }
    return path.length > 0 ? path : sorted;
}
function extractText(items, fallback) {
    if (!items?.length)
        return fallback ?? '';
    const parts = [];
    for (const item of items) {
        switch (item.type) {
            case 'text':
                if (item.text?.trim())
                    parts.push(item.text.trim());
                break;
            case 'thinking':
                if (item.thinking?.trim()) {
                    const excerpt = item.thinking.length > 600 ? item.thinking.slice(0, 600) + '…' : item.thinking;
                    parts.push(`[Reasoning]\n${excerpt.trim()}\n[/Reasoning]`);
                }
                break;
            case 'tool_use':
                if (item.name === 'artifacts' && item.input?.content != null) {
                    const lang = item.input.language || '';
                    const header = item.input.title ? ` (${item.input.title})` : '';
                    parts.push(`\`\`\`${lang}${header}\n${item.input.content}\n\`\`\``);
                }
                else if (item.name) {
                    parts.push(`[Tool: ${item.name}]`);
                }
                break;
            case 'tool_result':
                if (item.content?.length) {
                    const text = item.content.map(c => c.text ?? '').join('\n').trim();
                    if (text)
                        parts.push(`[Tool result]\n${text.length > 300 ? text.slice(0, 300) + '…' : text}`);
                }
                break;
            case 'voice_note':
                if (item.text?.trim())
                    parts.push(`[Voice note]\n${item.text.trim()}`);
                break;
        }
    }
    return parts.join('\n\n') || fallback || '';
}
function fmtTs(iso) {
    try {
        return new Date(iso).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: 'numeric', minute: '2-digit',
        });
    }
    catch {
        return iso;
    }
}
function formatConversation(conv, projectName) {
    const messages = linearizeMessages(conv.chat_messages, conv.current_leaf_message_uuid);
    const title = conv.name || `Conversation ${conv.uuid.slice(0, 8)}`;
    const metaLines = [
        `uuid: ${conv.uuid}`,
        conv.model ? `model: ${conv.model}` : '',
        `created: ${fmtTs(conv.created_at)}`,
        conv.updated_at ? `updated: ${fmtTs(conv.updated_at)}` : '',
        projectName ? `project: ${projectName}` : '',
        conv.is_starred ? `starred: true` : '',
        conv.summary ? `summary: ${conv.summary.slice(0, 200)}` : '',
    ].filter(Boolean);
    const displayMessages = messages.slice(0, 200);
    const truncatedCount = messages.length - displayMessages.length;
    const turns = displayMessages.map(msg => {
        const speaker = msg.sender === 'human' ? 'You' : 'Claude';
        const body = extractText(msg.content, msg.text);
        return `**${speaker}** · ${fmtTs(msg.created_at)}\n\n${body || '(no content)'}`;
    });
    if (truncatedCount > 0)
        turns.push(`[${truncatedCount} more messages not shown]`);
    const content = [
        `---\n${metaLines.join('\n')}\n---`,
        `# ${title}`,
        turns.join('\n\n---\n\n'),
    ].join('\n\n');
    return { title, content };
}
// ── Claude import tools ──────────────────────────────────────────────────────
function claudeImportConversationTool() {
    return {
        name: 'nexalog.claude.import_conversation',
        description: 'Import a single Claude conversation as a Nexalog note. Preserves full message history, model, timestamps, artifacts, and reasoning blocks. For bulk imports from a file, use nexalog.claude.import_export.',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                conversation: {
                    type: 'object',
                    description: 'Claude conversation object from conversations.json (must have uuid and chat_messages).',
                },
                projectName: { type: 'string', description: 'Project name to include in note metadata (optional).' },
            },
            required: ['conversation'],
        },
        hints: { estimatedMs: 3000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            if (!p.conversation?.uuid)
                throw new Error('conversation.uuid is required');
            const { title, content } = formatConversation(p.conversation, p.projectName);
            const data = await nexalogPost({
                entity: 'note', action: 'create', userId, title, content, kind: 'claude_conversation',
            });
            return `Imported: "${data.note.title}" (Note: ${data.note.id}, Claude UUID: ${p.conversation.uuid})`;
        },
    };
}
const IMPORT_TIMEOUT_MS = 30_000;
function claudeImportExportTool() {
    return {
        name: 'nexalog.claude.import_export',
        description: "Batch-import a Claude data export into Nexalog. Reads conversations.json (and optionally projects.json) from disk. Creates one note per conversation preserving full message history, model, timestamps, artifacts, and reasoning. Call repeatedly with increasing offset until all conversations are imported.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved).' },
                filePath: {
                    type: 'string',
                    description: 'Absolute path to conversations.json from the Claude export ZIP.',
                },
                projectsFilePath: {
                    type: 'string',
                    description: 'Absolute path to projects.json (optional — adds project names to note metadata).',
                },
                offset: {
                    type: 'number',
                    description: 'Start index for this batch (default 0). Pass nextOffset from the previous result to continue.',
                },
                batchSize: {
                    type: 'number',
                    description: 'Conversations to process per call (default 20, max 50).',
                },
                dryRun: {
                    type: 'boolean',
                    description: 'Preview total count and batch plan without creating any notes.',
                },
            },
            required: ['filePath'],
        },
        hints: { estimatedMs: IMPORT_TIMEOUT_MS, timeoutMs: IMPORT_TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const offset = Math.max(0, p.offset ?? 0);
            const batchSize = Math.min(50, Math.max(1, p.batchSize ?? 20));
            let conversations;
            try {
                const raw = await readFile(p.filePath, 'utf-8');
                conversations = JSON.parse(raw);
                if (!Array.isArray(conversations))
                    throw new Error('Expected a JSON array at root');
            }
            catch (e) {
                throw new Error(`Cannot read ${p.filePath}: ${e instanceof Error ? e.message : String(e)}`);
            }
            const projectNames = new Map();
            if (p.projectsFilePath) {
                try {
                    const raw = await readFile(p.projectsFilePath, 'utf-8');
                    const projects = JSON.parse(raw);
                    if (Array.isArray(projects)) {
                        for (const proj of projects) {
                            if (proj.uuid && proj.name)
                                projectNames.set(proj.uuid, proj.name);
                        }
                    }
                }
                catch { /* optional — ignore */ }
            }
            const total = conversations.length;
            const batch = conversations.slice(offset, offset + batchSize);
            const endIdx = offset + batch.length;
            const nextOffset = endIdx < total ? endIdx : null;
            if (p.dryRun) {
                const batches = Math.ceil(total / batchSize);
                return [
                    `Dry run — ${total} conversations total${projectNames.size > 0 ? `, ${projectNames.size} projects loaded` : ''}`,
                    `Batch size: ${batchSize} → ${batches} call(s) needed`,
                    `This batch would cover: ${offset + 1}–${Math.min(offset + batchSize, total)}`,
                ].join('\n');
            }
            let imported = 0;
            let failed = 0;
            const errs = [];
            for (const conv of batch) {
                if (!conv?.uuid) {
                    failed++;
                    continue;
                }
                try {
                    const projectName = conv.project_uuid ? projectNames.get(conv.project_uuid) : undefined;
                    const { title, content } = formatConversation(conv, projectName);
                    await nexalogPost({
                        entity: 'note', action: 'create', userId, title, content, kind: 'claude_conversation',
                    });
                    imported++;
                }
                catch (e) {
                    failed++;
                    errs.push(`${conv.uuid.slice(0, 8)}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            const pct = Math.round((endIdx / total) * 100);
            return [
                `Batch ${offset + 1}–${endIdx} of ${total} (${pct}%)`,
                `  Imported: ${imported} notes`,
                failed > 0 ? `  Failed: ${failed}` : '',
                errs.length > 0 ? `  Errors: ${errs.slice(0, 3).join('; ')}` : '',
                nextOffset != null
                    ? `\nCall again with offset=${nextOffset} to continue.`
                    : '\nAll conversations imported.',
            ].filter(Boolean).join('\n');
        },
    };
}
export async function activate(sdk) {
    try {
        _cachedUserId = await sdk.storage.get('nexalog_user_id');
    }
    catch { /* falls back to required userId param */ }
    sdk.registerTool(noteListTool());
    sdk.registerTool(noteSearchTool());
    sdk.registerTool(noteGetTool());
    sdk.registerTool(noteCreateTool());
    sdk.registerTool(noteUpdateTool());
    sdk.registerTool(noteDeleteTool());
    sdk.registerTool(bookmarkListTool());
    sdk.registerTool(bookmarkGetTool());
    sdk.registerTool(bookmarkAddTool());
    sdk.registerTool(bookmarkUpdateTool());
    sdk.registerTool(bookmarkDeleteTool());
    sdk.registerTool(bookmarkTagsListTool());
    sdk.registerTool(bookmarkTagCreateTool());
    sdk.registerTool(bookmarkTagAssignTool());
    sdk.registerTool(bookmarkTagRemoveTool());
    sdk.registerTool(memoCreateTool());
    sdk.registerTool(captureListTool());
    sdk.registerTool(captureGetTool());
    sdk.registerTool(captureCreateTool());
    sdk.registerTool(captureUpdateTool());
    sdk.registerTool(captureDeleteTool());
    sdk.registerTool(claudeImportConversationTool());
    sdk.registerTool(claudeImportExportTool());
}
