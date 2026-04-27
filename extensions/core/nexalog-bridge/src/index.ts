// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// @joeybuilt/nexalog-bridge — Pex tool extension that proxies tool calls to
// Nexalog's /api/plexo/data endpoint. Mirrors @joeybuilt/levio-bridge.

import type { PlexoSDK, ToolRegistration, InvokeContext } from '@plexo/sdk'

function nexalogBase(): string {
    return (process.env.NEXALOG_INTERNAL_URL ?? 'http://service:3300').replace(/\/$/, '')
}

function serviceHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY ?? ''}`,
        'Content-Type': 'application/json',
    }
}

const TIMEOUT_MS = 10_000

let _cachedUserId: string | null = null

function resolveUserId(params: { userId?: string }): string {
    const uid = params.userId || _cachedUserId || ''
    if (!uid) throw new Error('No Nexalog user ID available. Connect Nexalog in Settings > Integrations.')
    return uid
}

async function nexalogGet(params: URLSearchParams): Promise<unknown> {
    const res = await fetch(`${nexalogBase()}/api/plexo/data?${params}`, {
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Nexalog API error ${res.status}: ${body.slice(0, 200)}`)
    }
    return res.json()
}

async function nexalogPost(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${nexalogBase()}/api/plexo/data`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        throw new Error(`Nexalog API error ${res.status}: ${bodyText.slice(0, 200)}`)
    }
    return res.json()
}

function noteListTool(): ToolRegistration {
    return {
        name: 'nexalog.note.list',
        description:
            "List active notes in the user's Nexalog workspaces. Returns ID, title, kind, and updated time.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Nexalog user ID (auto-resolved from connection).' },
                limit: { type: 'number', description: 'Max results (1-100, default 30).' },
            },
            required: [],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; limit?: number }
            const userId = resolveUserId(p)
            const qp = new URLSearchParams({ entity: 'note', userId })
            if (p.limit) qp.set('limit', String(p.limit))
            const data = await nexalogGet(qp) as { notes: Array<{ id: string; title: string; kind?: string; updatedAt?: string }>; total: number }
            if (!data.notes?.length) return 'No notes found.'
            return [`${data.total} notes:`, ...data.notes.map((n) => `- ${n.id} | ${n.title || '(untitled)'}${n.kind && n.kind !== 'note' ? ` [${n.kind}]` : ''}`)].join('\n')
        },
    }
}

function noteSearchTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; q: string; limit?: number }
            const userId = resolveUserId(p)
            const qp = new URLSearchParams({ entity: 'note_search', userId, q: p.q })
            if (p.limit) qp.set('limit', String(p.limit))
            const data = await nexalogGet(qp) as { notes: Array<{ id: string; title: string; kind?: string }>; total: number }
            if (!data.notes?.length) return `No matches for "${p.q}".`
            return [`${data.total} matches for "${p.q}":`, ...data.notes.map((n) => `- ${n.id} | ${n.title || '(untitled)'}${n.kind && n.kind !== 'note' ? ` [${n.kind}]` : ''}`)].join('\n')
        },
    }
}

function noteGetTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; id: string }
            const userId = resolveUserId(p)
            const qp = new URLSearchParams({ entity: 'note', userId, id: p.id })
            const data = await nexalogGet(qp) as { note: { id: string; title: string; content: string; kind?: string; updatedAt?: string } }
            const n = data.note
            return [`# ${n.title || '(untitled)'}`, `ID: ${n.id}${n.kind && n.kind !== 'note' ? ` | Kind: ${n.kind}` : ''}`, '', n.content || '(no content)'].join('\n')
        },
    }
}

function noteCreateTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; title: string; content?: string; kind?: string }
            const userId = resolveUserId(p)
            const data = await nexalogPost({ entity: 'note', action: 'create', userId, title: p.title, content: p.content, kind: p.kind }) as { note: { id: string; title: string } }
            return `Note created: ${data.note.title} (ID: ${data.note.id})`
        },
    }
}

function noteUpdateTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; id: string; title?: string; content?: string }
            const userId = resolveUserId(p)
            const data = await nexalogPost({ entity: 'note', action: 'update', userId, id: p.id, title: p.title, content: p.content }) as { note: { id: string; title: string } }
            return `Note updated: ${data.note.title} (ID: ${data.note.id})`
        },
    }
}

function noteDeleteTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; id: string }
            const userId = resolveUserId(p)
            const data = await nexalogPost({ entity: 'note', action: 'delete', userId, id: p.id }) as { deleted: boolean; note: { id: string; title: string } }
            return `Note deleted: ${data.note.title} (ID: ${data.note.id})`
        },
    }
}

function bookmarkListTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; limit?: number }
            const userId = resolveUserId(p)
            const qp = new URLSearchParams({ entity: 'capture_source', userId, kind: 'url' })
            if (p.limit) qp.set('limit', String(p.limit))
            const data = await nexalogGet(qp) as { sources: Array<{ id: string; url?: string; ogTitle?: string; ogImage?: string; faviconUrl?: string; state: string }>; total: number }
            if (!data.sources?.length) return 'No bookmarks saved.'
            return [`${data.total} bookmarks:`, ...data.sources.map((s) => {
                const parts = [`- ${s.id} | ${s.ogTitle || s.url || '(no url)'}`]
                if (s.ogImage) parts.push(`  thumbnail: ${s.ogImage}`)
                else if (s.faviconUrl) parts.push(`  favicon: ${s.faviconUrl}`)
                return parts.join('\n')
            })].join('\n')
        },
    }
}

function bookmarkAddTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; url: string; title?: string }
            const userId = resolveUserId(p)
            const data = await nexalogPost({ entity: 'capture_source', action: 'create', userId, kind: 'url', url: p.url, content: p.title ?? '' }) as { source: { id: string; kind: string } }
            return `Bookmark saved: ${p.url} (ID: ${data.source.id})`
        },
    }
}

function bookmarkDeleteTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; id: string }
            const userId = resolveUserId(p)
            await nexalogPost({ entity: 'capture_source', action: 'delete', userId, id: p.id })
            return `Bookmark deleted (ID: ${p.id})`
        },
    }
}

function captureListTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; state?: string; limit?: number }
            const userId = resolveUserId(p)
            const qp = new URLSearchParams({ entity: 'capture_source', userId })
            if (p.state) qp.set('state', p.state)
            if (p.limit) qp.set('limit', String(p.limit))
            const data = await nexalogGet(qp) as { sources: Array<{ id: string; kind: string; url?: string; state: string }>; total: number }
            if (!data.sources?.length) return 'No capture sources.'
            return [`${data.total} captures:`, ...data.sources.map((s) => `- ${s.id} | [${s.state}] ${s.kind}${s.url ? ` ${s.url}` : ''}`)].join('\n')
        },
    }
}

function captureCreateTool(): ToolRegistration {
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
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; kind: string; content?: string; url?: string }
            const userId = resolveUserId(p)
            const data = await nexalogPost({ entity: 'capture_source', action: 'create', userId, kind: p.kind, content: p.content, url: p.url }) as { source: { id: string; kind: string } }
            return `Capture created: ${data.source.kind} (ID: ${data.source.id})`
        },
    }
}

export async function activate(sdk: PlexoSDK): Promise<void> {
    try {
        _cachedUserId = await sdk.storage.get('nexalog_user_id')
    } catch { /* falls back to required userId param */ }

    sdk.registerTool(noteListTool())
    sdk.registerTool(noteSearchTool())
    sdk.registerTool(noteGetTool())
    sdk.registerTool(noteCreateTool())
    sdk.registerTool(noteUpdateTool())
    sdk.registerTool(noteDeleteTool())
    sdk.registerTool(bookmarkListTool())
    sdk.registerTool(bookmarkAddTool())
    sdk.registerTool(bookmarkDeleteTool())
    sdk.registerTool(captureListTool())
    sdk.registerTool(captureCreateTool())
}
