// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// @joeybuilt/fonto-bridge — Pex tool extension that proxies tool calls to
// Fonto's /api/plexo/data endpoint. Mirrors @joeybuilt/levio-bridge.
function fontoBase() {
    return (process.env.FONTO_INTERNAL_URL ?? 'http://fonto:3500').replace(/\/$/, '');
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
        throw new Error('No Fonto user ID available. Connect Fonto in Settings > Integrations.');
    return uid;
}
async function fontoGet(params) {
    const res = await fetch(`${fontoBase()}/api/plexo/data?${params}`, {
        headers: serviceHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Fonto API error ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
}
async function fontoPost(body) {
    const res = await fetch(`${fontoBase()}/api/plexo/data`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Fonto API error ${res.status}: ${bodyText.slice(0, 200)}`);
    }
    return res.json();
}
function assetListTool() {
    return {
        name: 'fonto.asset.list',
        description: "List active assets in the user's Fonto workspace. Returns filename, mime type, classification, description, captured timestamp.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved from connection).' },
                subtype: { type: 'string', description: 'Filter by classification (e.g. photo, screenshot, receipt, document).' },
                limit: { type: 'number', description: 'Max results (1-100, default 30).' },
            },
            required: [],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'asset', userId });
            if (p.subtype)
                qp.set('subtype', p.subtype);
            if (p.limit)
                qp.set('limit', String(p.limit));
            const data = await fontoGet(qp);
            if (!data.assets?.length)
                return 'No assets found.';
            return [`${data.total} assets:`, ...data.assets.slice(0, 30).map((a) => `- ${a.filename}${a.classification ? ` [${a.classification}]` : ''}${a.description ? `: ${a.description}` : ''}`)].join('\n');
        },
    };
}
function assetSearchTool() {
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
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'asset_search', userId, q: p.q });
            if (p.limit)
                qp.set('limit', String(p.limit));
            const data = await fontoGet(qp);
            if (!data.assets?.length)
                return `No matches for "${p.q}".`;
            return [`${data.total} matches for "${p.q}":`, ...data.assets.map((a) => `- ${a.filename}${a.classification ? ` [${a.classification}]` : ''}${a.description ? `: ${a.description}` : ''}`)].join('\n');
        },
    };
}
function collectionListTool() {
    return {
        name: 'fonto.collection.list',
        description: "List collections (curated asset groups) in the user's Fonto workspace.",
        parameters: {
            type: 'object',
            properties: { userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' } },
            required: [],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const userId = resolveUserId(params);
            const data = await fontoGet(new URLSearchParams({ entity: 'collection', userId }));
            if (!data.collections?.length)
                return 'No collections.';
            return [`${data.total} collections:`, ...data.collections.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ''}`)].join('\n');
        },
    };
}
function tagListTool() {
    return {
        name: 'fonto.tag.list',
        description: "List tags (labels) in the user's Fonto workspace.",
        parameters: {
            type: 'object',
            properties: { userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' } },
            required: [],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const userId = resolveUserId(params);
            const data = await fontoGet(new URLSearchParams({ entity: 'tag', userId }));
            if (!data.tags?.length)
                return 'No tags.';
            return [`${data.total} tags:`, ...data.tags.map((t) => `- ${t.name}${t.aiSuggested ? ' (AI)' : ''}`)].join('\n');
        },
    };
}
function tagCreateTool() {
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
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await fontoPost({ entity: 'tag', action: 'create', userId, name: p.name, color: p.color });
            return `Tag created: ${data.tag.name} (ID: ${data.tag.id})`;
        },
    };
}
export async function activate(sdk) {
    try {
        _cachedUserId = await sdk.storage.get('fonto_user_id');
    }
    catch { /* falls back to required userId param */ }
    sdk.registerTool(assetListTool());
    sdk.registerTool(assetSearchTool());
    sdk.registerTool(collectionListTool());
    sdk.registerTool(tagListTool());
    sdk.registerTool(tagCreateTool());
}
