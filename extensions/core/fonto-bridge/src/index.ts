// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// @joeybuilt/fonto-bridge — Pex tool extension that proxies tool calls to
// Fonto's /api/plexo/data endpoint. Mirrors @joeybuilt/levio-bridge.

import type { PlexoSDK, ToolRegistration, InvokeContext } from '@plexo/sdk'

function fontoBase(): string {
    return (process.env.FONTO_INTERNAL_URL ?? 'http://fonto:3500').replace(/\/$/, '')
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
    if (!uid) throw new Error('No Fonto user ID available. Connect Fonto in Settings > Integrations.')
    return uid
}

async function fontoGet(params: URLSearchParams): Promise<unknown> {
    const res = await fetch(`${fontoBase()}/api/plexo/data?${params}`, {
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Fonto API error ${res.status}: ${body.slice(0, 200)}`)
    }
    return res.json()
}

async function fontoPost(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${fontoBase()}/api/plexo/data`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        throw new Error(`Fonto API error ${res.status}: ${bodyText.slice(0, 200)}`)
    }
    return res.json()
}

function assetListTool(): ToolRegistration {
    return {
        name: 'fonto.asset.list',
        description:
            "List active assets in the user's Fonto workspace. Filter by classification, collection, or tag. Returns ID, filename, classification, and description.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved from connection).' },
                subtype: { type: 'string', description: 'Filter by classification (e.g. photo, screenshot, receipt, document).' },
                collectionId: { type: 'string', description: 'Filter to assets in a specific collection (UUID).' },
                tagId: { type: 'string', description: 'Filter to assets with a specific tag (UUID).' },
                limit: { type: 'number', description: 'Max results (1-100, default 30).' },
            },
            required: [],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; subtype?: string; collectionId?: string; tagId?: string; limit?: number }
            const userId = resolveUserId(p)
            const qp = new URLSearchParams({ entity: 'asset', userId })
            if (p.subtype) qp.set('subtype', p.subtype)
            if (p.collectionId) qp.set('collectionId', p.collectionId)
            if (p.tagId) qp.set('tagId', p.tagId)
            if (p.limit) qp.set('limit', String(p.limit))
            const data = await fontoGet(qp) as { assets: Array<{ id: string; filename: string; classification?: string; description?: string }>; total: number }
            if (!data.assets?.length) return 'No assets found.'
            return [`${data.total} assets:`, ...data.assets.slice(0, 30).map((a) => `- ${a.id} | ${a.filename}${a.classification ? ` [${a.classification}]` : ''}${a.description ? `: ${a.description}` : ''}`)].join('\n')
        },
    }
}

function assetSearchTool(): ToolRegistration {
    return {
        name: 'fonto.asset.search',
        description: 'Search assets by filename, AI description, or extracted text.',
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved from connection).' },
                q: { type: 'string', description: 'Search query.' },
                limit: { type: 'number', description: 'Max results (1-50, default 20).' },
            },
            required: ['q'],
        },
        hints: { estimatedMs: 2000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; q: string; limit?: number }
            const userId = resolveUserId(p)
            const qp = new URLSearchParams({ entity: 'asset_search', userId, q: p.q })
            if (p.limit) qp.set('limit', String(p.limit))
            const data = await fontoGet(qp) as { assets: Array<{ id: string; filename: string; classification?: string; description?: string }>; total: number }
            if (!data.assets?.length) return `No matches for "${p.q}".`
            return [`${data.total} matches for "${p.q}":`, ...data.assets.map((a) => `- ${a.id} | ${a.filename}${a.classification ? ` [${a.classification}]` : ''}${a.description ? `: ${a.description}` : ''}`)].join('\n')
        },
    }
}

function collectionListTool(): ToolRegistration {
    return {
        name: 'fonto.collection.list',
        description: "List collections (curated asset groups) in the user's Fonto workspace.",
        parameters: {
            type: 'object',
            properties: { userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' } },
            required: [],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const userId = resolveUserId(params as { userId?: string })
            const data = await fontoGet(new URLSearchParams({ entity: 'collection', userId })) as { collections: Array<{ id: string; name: string; description?: string }>; total: number }
            if (!data.collections?.length) return 'No collections.'
            return [`${data.total} collections:`, ...data.collections.map((c) => `- ${c.id} | ${c.name}${c.description ? `: ${c.description}` : ''}`)].join('\n')
        },
    }
}

function collectionCreateTool(): ToolRegistration {
    return {
        name: 'fonto.collection.create',
        description: "Create a new collection in the user's Fonto workspace.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                name: { type: 'string', description: 'Collection name.' },
                description: { type: 'string', description: 'Optional description.' },
            },
            required: ['name'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; name: string; description?: string }
            const userId = resolveUserId(p)
            const data = await fontoPost({ entity: 'collection', action: 'create', userId, name: p.name, description: p.description }) as { collection: { id: string; name: string } }
            return `Collection created: ${data.collection.name} (ID: ${data.collection.id})`
        },
    }
}

function collectionAddAssetTool(): ToolRegistration {
    return {
        name: 'fonto.collection.add_asset',
        description: "Add an asset to a collection. Use fonto.collection.list and fonto.asset.list/search to find IDs.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                collectionId: { type: 'string', description: 'Collection UUID.' },
                assetId: { type: 'string', description: 'Asset UUID.' },
            },
            required: ['collectionId', 'assetId'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; collectionId: string; assetId: string }
            const userId = resolveUserId(p)
            await fontoPost({ entity: 'collection', action: 'add_asset', userId, collectionId: p.collectionId, assetId: p.assetId })
            return `Asset ${p.assetId} added to collection ${p.collectionId}`
        },
    }
}

function collectionRemoveAssetTool(): ToolRegistration {
    return {
        name: 'fonto.collection.remove_asset',
        description: "Remove an asset from a collection.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                collectionId: { type: 'string', description: 'Collection UUID.' },
                assetId: { type: 'string', description: 'Asset UUID.' },
            },
            required: ['collectionId', 'assetId'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; collectionId: string; assetId: string }
            const userId = resolveUserId(p)
            await fontoPost({ entity: 'collection', action: 'remove_asset', userId, collectionId: p.collectionId, assetId: p.assetId })
            return `Asset ${p.assetId} removed from collection ${p.collectionId}`
        },
    }
}

function tagListTool(): ToolRegistration {
    return {
        name: 'fonto.tag.list',
        description: "List tags (labels) in the user's Fonto workspace.",
        parameters: {
            type: 'object',
            properties: { userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' } },
            required: [],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const userId = resolveUserId(params as { userId?: string })
            const data = await fontoGet(new URLSearchParams({ entity: 'tag', userId })) as { tags: Array<{ id: string; name: string; aiSuggested?: boolean }>; total: number }
            if (!data.tags?.length) return 'No tags.'
            return [`${data.total} tags:`, ...data.tags.map((t) => `- ${t.id} | ${t.name}${t.aiSuggested ? ' (AI)' : ''}`)].join('\n')
        },
    }
}

function tagCreateTool(): ToolRegistration {
    return {
        name: 'fonto.tag.create',
        description: "Create a new tag in the user's Fonto workspace.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                name: { type: 'string', description: 'Tag name.' },
                color: { type: 'string', description: 'Hex color (default #6366f1).' },
            },
            required: ['name'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; name: string; color?: string }
            const userId = resolveUserId(p)
            const data = await fontoPost({ entity: 'tag', action: 'create', userId, name: p.name, color: p.color }) as { tag: { id: string; name: string } }
            return `Tag created: ${data.tag.name} (ID: ${data.tag.id})`
        },
    }
}

function assetTagTool(): ToolRegistration {
    return {
        name: 'fonto.asset.tag',
        description: "Apply a tag to an asset. Use fonto.tag.list and fonto.asset.list/search to find IDs.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                assetId: { type: 'string', description: 'Asset UUID.' },
                tagId: { type: 'string', description: 'Tag UUID.' },
            },
            required: ['assetId', 'tagId'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; assetId: string; tagId: string }
            const userId = resolveUserId(p)
            await fontoPost({ entity: 'asset', action: 'tag', userId, assetId: p.assetId, tagId: p.tagId })
            return `Tag ${p.tagId} applied to asset ${p.assetId}`
        },
    }
}

function assetUntagTool(): ToolRegistration {
    return {
        name: 'fonto.asset.untag',
        description: "Remove a tag from an asset.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                assetId: { type: 'string', description: 'Asset UUID.' },
                tagId: { type: 'string', description: 'Tag UUID.' },
            },
            required: ['assetId', 'tagId'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: true },
        handler: async (params: unknown, _ctx: InvokeContext) => {
            const p = params as { userId?: string; assetId: string; tagId: string }
            const userId = resolveUserId(p)
            await fontoPost({ entity: 'asset', action: 'untag', userId, assetId: p.assetId, tagId: p.tagId })
            return `Tag ${p.tagId} removed from asset ${p.assetId}`
        },
    }
}

export async function activate(sdk: PlexoSDK): Promise<void> {
    try {
        _cachedUserId = await sdk.storage.get('fonto_user_id')
    } catch { /* falls back to required userId param */ }

    sdk.registerTool(assetListTool())
    sdk.registerTool(assetSearchTool())
    sdk.registerTool(assetTagTool())
    sdk.registerTool(assetUntagTool())
    sdk.registerTool(collectionListTool())
    sdk.registerTool(collectionCreateTool())
    sdk.registerTool(collectionAddAssetTool())
    sdk.registerTool(collectionRemoveAssetTool())
    sdk.registerTool(tagListTool())
    sdk.registerTool(tagCreateTool())
}
