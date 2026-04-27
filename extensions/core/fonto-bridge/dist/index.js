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
        description: "List active assets in the user's Fonto workspace. Filter by classification, collection, or tag. Returns ID, filename, classification, and description.",
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
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'asset', userId });
            if (p.subtype)
                qp.set('subtype', p.subtype);
            if (p.collectionId)
                qp.set('collectionId', p.collectionId);
            if (p.tagId)
                qp.set('tagId', p.tagId);
            if (p.limit)
                qp.set('limit', String(p.limit));
            const data = await fontoGet(qp);
            if (!data.assets?.length)
                return 'No assets found.';
            return [`${data.total} assets:`, ...data.assets.slice(0, 30).map((a) => `- ${a.id} | ${a.filename}${a.classification ? ` [${a.classification}]` : ''}${a.description ? `: ${a.description}` : ''}`)].join('\n');
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
            return [`${data.total} matches for "${p.q}":`, ...data.assets.map((a) => `- ${a.id} | ${a.filename}${a.classification ? ` [${a.classification}]` : ''}${a.description ? `: ${a.description}` : ''}`)].join('\n');
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
            return [`${data.total} collections:`, ...data.collections.map((c) => `- ${c.id} | ${c.name}${c.description ? `: ${c.description}` : ''}`)].join('\n');
        },
    };
}
function collectionCreateTool() {
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
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await fontoPost({ entity: 'collection', action: 'create', userId, name: p.name, description: p.description });
            return `Collection created: ${data.collection.name} (ID: ${data.collection.id})`;
        },
    };
}
function collectionAddAssetTool() {
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
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await fontoPost({ entity: 'collection', action: 'add_asset', userId, collectionId: p.collectionId, assetId: p.assetId });
            return `Asset ${p.assetId} added to collection ${p.collectionId}`;
        },
    };
}
function collectionRemoveAssetTool() {
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
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await fontoPost({ entity: 'collection', action: 'remove_asset', userId, collectionId: p.collectionId, assetId: p.assetId });
            return `Asset ${p.assetId} removed from collection ${p.collectionId}`;
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
            return [`${data.total} tags:`, ...data.tags.map((t) => `- ${t.id} | ${t.name}${t.aiSuggested ? ' (AI)' : ''}`)].join('\n');
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
function assetGetTool() {
    return {
        name: 'fonto.asset.get',
        description: "Fetch full details of a single asset by ID, including description and extracted text.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                id: { type: 'string', description: 'Asset UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'asset', userId, id: p.id });
            const data = await fontoGet(qp);
            const a = data.asset;
            const lines = [
                `# ${a.filename}`,
                `ID: ${a.id}`,
                `Type: ${a.mimeType || 'unknown'}${a.classification ? ` [${a.classification}]` : ''}`,
                a.sizeBytes ? `Size: ${Math.round(a.sizeBytes / 1024)} KB` : '',
                a.description ? `Description: ${a.description}` : '',
                a.extractedText ? `Extracted text: ${a.extractedText.slice(0, 500)}${a.extractedText.length > 500 ? '…' : ''}` : '',
            ].filter(Boolean);
            return lines.join('\n');
        },
    };
}
function assetDeleteTool() {
    return {
        name: 'fonto.asset.delete',
        description: "Soft-delete an asset by ID. It will no longer appear in listings.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                id: { type: 'string', description: 'Asset UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await fontoPost({ entity: 'asset', action: 'delete', userId, id: p.id });
            return `Asset deleted: ${data.asset.filename} (ID: ${data.asset.id})`;
        },
    };
}
function collectionGetTool() {
    return {
        name: 'fonto.collection.get',
        description: "Fetch details of a single collection by ID.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                id: { type: 'string', description: 'Collection UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1000, timeoutMs: TIMEOUT_MS, hasSideEffects: false, idempotent: true },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const qp = new URLSearchParams({ entity: 'collection', userId, id: p.id });
            const data = await fontoGet(qp);
            const c = data.collection;
            return [`# ${c.name}`, `ID: ${c.id}`, c.description ? `Description: ${c.description}` : ''].filter(Boolean).join('\n');
        },
    };
}
function collectionUpdateTool() {
    return {
        name: 'fonto.collection.update',
        description: "Rename or update the description of a collection.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                id: { type: 'string', description: 'Collection UUID.' },
                name: { type: 'string', description: 'New name (omit to leave unchanged).' },
                description: { type: 'string', description: 'New description (omit to leave unchanged).' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await fontoPost({ entity: 'collection', action: 'update', userId, id: p.id, name: p.name, description: p.description });
            return `Collection updated: ${data.collection.name} (ID: ${data.collection.id})`;
        },
    };
}
function collectionDeleteTool() {
    return {
        name: 'fonto.collection.delete',
        description: "Delete a collection by ID. Assets in the collection are NOT deleted, only the collection itself.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                id: { type: 'string', description: 'Collection UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await fontoPost({ entity: 'collection', action: 'delete', userId, id: p.id });
            return `Collection deleted (ID: ${p.id})`;
        },
    };
}
function tagUpdateTool() {
    return {
        name: 'fonto.tag.update',
        description: "Rename or recolor a tag.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                id: { type: 'string', description: 'Tag UUID.' },
                name: { type: 'string', description: 'New name (omit to leave unchanged).' },
                color: { type: 'string', description: 'New hex color (omit to leave unchanged).' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            const data = await fontoPost({ entity: 'tag', action: 'update', userId, id: p.id, name: p.name, color: p.color });
            return `Tag updated: ${data.tag.name} (ID: ${data.tag.id})`;
        },
    };
}
function tagDeleteTool() {
    return {
        name: 'fonto.tag.delete',
        description: "Delete a tag by ID. The tag is removed from all assets it was applied to.",
        parameters: {
            type: 'object',
            properties: {
                userId: { type: 'string', description: 'Fonto user ID (auto-resolved).' },
                id: { type: 'string', description: 'Tag UUID.' },
            },
            required: ['id'],
        },
        hints: { estimatedMs: 1500, timeoutMs: TIMEOUT_MS, hasSideEffects: true, idempotent: false },
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await fontoPost({ entity: 'tag', action: 'delete', userId, id: p.id });
            return `Tag deleted (ID: ${p.id})`;
        },
    };
}
function assetTagTool() {
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
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await fontoPost({ entity: 'asset', action: 'tag', userId, assetId: p.assetId, tagId: p.tagId });
            return `Tag ${p.tagId} applied to asset ${p.assetId}`;
        },
    };
}
function assetUntagTool() {
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
        handler: async (params, _ctx) => {
            const p = params;
            const userId = resolveUserId(p);
            await fontoPost({ entity: 'asset', action: 'untag', userId, assetId: p.assetId, tagId: p.tagId });
            return `Tag ${p.tagId} removed from asset ${p.assetId}`;
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
    sdk.registerTool(assetGetTool());
    sdk.registerTool(assetDeleteTool());
    sdk.registerTool(assetTagTool());
    sdk.registerTool(assetUntagTool());
    sdk.registerTool(collectionListTool());
    sdk.registerTool(collectionGetTool());
    sdk.registerTool(collectionCreateTool());
    sdk.registerTool(collectionUpdateTool());
    sdk.registerTool(collectionDeleteTool());
    sdk.registerTool(collectionAddAssetTool());
    sdk.registerTool(collectionRemoveAssetTool());
    sdk.registerTool(tagListTool());
    sdk.registerTool(tagCreateTool());
    sdk.registerTool(tagUpdateTool());
    sdk.registerTool(tagDeleteTool());
}
