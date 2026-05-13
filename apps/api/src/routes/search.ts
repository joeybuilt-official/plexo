// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Search / Web-Search configuration routes.
 *
 * GET  /api/v1/search/settings?workspaceId=...
 *   Returns whether a Brave Search API key is configured (redacted).
 *
 * PUT  /api/v1/search/settings
 *   Body: { workspaceId, apiKey }
 *   Encrypts + stores the Brave Search API key into workspace.settings.search.
 *   Send apiKey: '__CLEAR__' to remove.
 *
 * POST /api/v1/search/test
 *   Body: { workspaceId, apiKey? }
 *   Validates the stored (or provided) key against Brave's /res/v1/web/search endpoint.
 *   Returns: { ok: boolean, message: string }
 *
 * Key storage: workspace.settings.search.braveApiKey (AES-256-GCM via crypto.ts)
 * Fallback: if no workspace key, falls back to BRAVE_SEARCH_API_KEY env var.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { encrypt, decrypt } from '../crypto.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

export const searchRouter: RouterType = Router()

const CONFIGURED_SENTINEL = '__configured__'
const BRAVE_API = 'https://api.search.brave.com'

// ── Helpers ──────────────────────────────────────────────────────────────────

function isEncrypted(v: string): boolean {
    return v.startsWith('enc:')
}

type SearchSettings = {
    braveApiKey?: string
}

async function loadSearchSettings(workspaceId: string): Promise<SearchSettings> {
    const [ws] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)

    return ((ws?.settings as Record<string, unknown>)?.search ?? {}) as SearchSettings
}

export async function getDecryptedBraveKey(workspaceId: string): Promise<string | null> {
    try {
        const settings = await loadSearchSettings(workspaceId)
        if (!settings.braveApiKey) {
            // Fall back to env var for self-hosters who set it globally
            return process.env.BRAVE_SEARCH_API_KEY ?? null
        }
        if (isEncrypted(settings.braveApiKey)) {
            return decrypt(settings.braveApiKey, workspaceId)
        }
        return settings.braveApiKey
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to decrypt Brave Search key, falling back to env')
        return process.env.BRAVE_SEARCH_API_KEY ?? null
    }
}

// ── GET /api/v1/search/settings ──────────────────────────────────────────────

searchRouter.get('/settings', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const settings = await loadSearchSettings(workspaceId)
        const hasEnvKey = !!process.env.BRAVE_SEARCH_API_KEY
        const hasDbKey = !!settings.braveApiKey
        res.json({
            configured: hasDbKey || hasEnvKey,
            // Distinguish DB-stored key (user-owned) from env fallback (admin-configured)
            source: hasDbKey ? 'workspace' : hasEnvKey ? 'environment' : 'none',
            apiKey: hasDbKey ? CONFIGURED_SENTINEL : null,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'GET search/settings failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load search settings' } })
    }
})

// ── PUT /api/v1/search/settings ──────────────────────────────────────────────

searchRouter.put('/settings', async (req, res) => {
    const { workspaceId, apiKey } = req.body as {
        workspaceId?: string
        apiKey?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const currentSettings = (ws.settings ?? {}) as Record<string, unknown>
        const currentSearch = (currentSettings.search ?? {}) as SearchSettings
        const updatedSearch: SearchSettings = { ...currentSearch }

        if (apiKey !== undefined) {
            if (apiKey === CONFIGURED_SENTINEL) {
                // No-op — keep existing
            } else if (apiKey === '__CLEAR__' || apiKey === '') {
                delete updatedSearch.braveApiKey
            } else {
                updatedSearch.braveApiKey = encrypt(apiKey, workspaceId)
            }
        }

        const newSettings = { ...currentSettings, search: updatedSearch }
        await db.update(workspaces).set({ settings: newSettings }).where(eq(workspaces.id, workspaceId))

        logger.info({ workspaceId, hasKey: !!updatedSearch.braveApiKey }, 'Search settings updated')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, workspaceId }, 'PUT search/settings failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save search settings' } })
    }
})

// ── POST /api/v1/search/test ─────────────────────────────────────────────────

searchRouter.post('/test', async (req, res) => {
    const { workspaceId, apiKey: incomingKey } = req.body as {
        workspaceId?: string
        apiKey?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.json({ ok: false, message: 'Valid workspaceId required' })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // Resolve key: plaintext from request > stored encrypted > env fallback
    let key: string | null = null
    if (incomingKey && incomingKey !== CONFIGURED_SENTINEL) {
        key = incomingKey
    } else {
        key = await getDecryptedBraveKey(workspaceId)
    }

    if (!key) {
        res.json({ ok: false, message: 'No Brave Search API key configured.' })
        return
    }

    try {
        const start = Date.now()
        const params = new URLSearchParams({ q: 'Plexo AI', count: '1' })
        const r = await fetch(`${BRAVE_API}/res/v1/web/search?${params}`, {
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': key,
            },
            signal: AbortSignal.timeout(8000),
        })
        const latencyMs = Date.now() - start

        if (r.status === 401 || r.status === 403) {
            res.json({ ok: false, message: 'Invalid API key. Check your key at brave.com/search/api.' })
            return
        }
        if (r.status === 429) {
            res.json({ ok: false, message: 'Rate limit reached. Key is valid but quota is exhausted.' })
            return
        }
        if (!r.ok) {
            res.json({ ok: false, message: `Brave Search returned HTTP ${r.status}` })
            return
        }

        const data = await r.json() as { web?: { results?: unknown[] } }
        const count = data.web?.results?.length ?? 0
        res.json({
            ok: true,
            message: `Connected — ${count} result${count !== 1 ? 's' : ''} returned (${latencyMs}ms)`,
            latencyMs,
        })
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Brave Search test failed')
        res.json({ ok: false, message: 'Connection to Brave Search failed. Check network connectivity and API key.' })
    }
})
