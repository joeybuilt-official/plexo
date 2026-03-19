// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * GET /api/v1/workspaces/:id/introspect
 *
 * Returns a complete IntrospectionSnapshot for the workspace.
 * Used by:
 *  - The Intelligence page in the dashboard
 *  - Any operator tooling that wants to interrogate agent capabilities
 *
 * Response is Redis-cached for 30s to avoid hammering the DB
 * on polling UIs. Cache is invalidated by:
 *  - PUT /workspaces/:id/ai-providers
 *  - POST /connections/install
 *  - DELETE /connections/:id
 *  - PUT /plugins/:id (enable/disable)
 *
 * Credentials are NEVER included. Status booleans only.
 */
import { Router } from 'express'
import { createClient } from 'redis'
import { buildIntrospectionSnapshot } from '@plexo/agent/introspection'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

const router: Router = Router({ mergeParams: true })
const TTL_SECONDS = 30

// ── Cache helpers ─────────────────────────────────────────────────────────────

let _redis: ReturnType<typeof createClient> | null = null

async function getRedis() {
    if (_redis) return _redis
    _redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
    _redis.on('error', (err) => logger.warn({ err }, 'introspect-redis error'))
    await _redis.connect()
    return _redis
}

export function introspectCacheKey(workspaceId: string) {
    return `plexo:introspect:${workspaceId}`
}

export async function invalidateIntrospectCache(workspaceId: string) {
    try {
        const redis = await getRedis()
        await redis.del(introspectCacheKey(workspaceId))
    } catch { /* non-fatal — cache miss is fine */ }
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
    const wsId = (req.params as { id: string }).id

    if (!UUID_RE.test(wsId)) {
        return res.status(400).json({ error: 'Invalid workspace ID' })
    }

    // Check cache first — skip if ?bust=1 (e.g. manual Refresh button click)
    const bustCache = req.query.bust === '1' || req.query.bust === 'true'
    if (!bustCache) {
        try {
            const redis = await getRedis()
            const cached = await redis.get(introspectCacheKey(wsId))
            if (cached) {
                return res.json(JSON.parse(cached))
            }
        } catch { /* cache miss — fall through */ }
    }

    try {
        const snapshot = await buildIntrospectionSnapshot(wsId)

        // Cache it
        try {
            const redis = await getRedis()
            await redis.set(introspectCacheKey(wsId), JSON.stringify(snapshot), { EX: TTL_SECONDS })
        } catch { /* non-fatal */ }

        return res.json(snapshot)
    } catch (err) {
        logger.error({ err, wsId }, 'introspect: buildIntrospectionSnapshot failed')
        return res.status(500).json({ error: 'Failed to build introspection snapshot' })
    }
})

export { router as introspectRouter }
