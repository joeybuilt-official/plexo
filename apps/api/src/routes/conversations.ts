import { Router, type Router as RouterType } from 'express'
import { db, desc, eq, sql, asc } from '@plexo/db'
import { conversations } from '@plexo/db'
import { logger } from '../logger.js'

export const conversationsRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── GET /api/v1/conversations/:id ─────────────────────────────────────────────
// Returns a single conversation record by its ID (ULID).

conversationsRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    if (!id) {
        res.status(400).json({ error: { code: 'MISSING_ID', message: 'id required' } })
        return
    }
    try {
        const [item] = await db.select().from(conversations)
            .where(eq(conversations.id, id))
            .limit(1)
        if (!item) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } })
            return
        }
        res.json(item)
    } catch (err) {
        logger.error({ err, id }, 'GET /api/v1/conversations/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch conversation' } })
    }
})

// ── GET /api/v1/conversations?workspaceId=&limit=&cursor=&sessionId= ─────────
// Returns conversation records for a workspace, newest first.
// If ?sessionId= is provided, returns all turns for that session in chronological order.
// If ?groupBySession=true, returns one entry per session (most recent turn per session).

conversationsRouter.get('/', async (req, res) => {
    const { workspaceId, limit = '50', cursor, sessionId, groupBySession } = req.query as Record<string, string>

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.json({ items: [], nextCursor: null })
        return
    }

    try {
        const lim = Math.min(parseInt(limit, 10) || 50, 200)

        // Session thread view: all turns for a specific session ID (chronological)
        if (sessionId) {
            const items = await db.select().from(conversations)
                .where(sql`workspace_id = ${workspaceId} AND session_id = ${sessionId}`)
                .orderBy(asc(conversations.createdAt))
                .limit(lim)
            res.json({ items, nextCursor: null, sessionId })
            return
        }

        // Grouped view: one row per session (the most recent turn), plus a turn count.
        // Falls back to per-row view for conversations without a sessionId.
        if (groupBySession === 'true') {
            // Use a window function to get the latest turn per session
            // plus a count of total turns per session.
            const rawRows = await db.execute(sql`
                WITH ranked AS (
                    SELECT *,
                           ROW_NUMBER() OVER (PARTITION BY COALESCE(session_id, id) ORDER BY created_at DESC) AS rn,
                           COUNT(*) OVER (PARTITION BY COALESCE(session_id, id)) AS turn_count
                    FROM conversations
                    WHERE workspace_id = ${workspaceId}
                    ${cursor ? sql`AND created_at < (SELECT created_at FROM conversations WHERE id = ${cursor})` : sql``}
                )
                SELECT * FROM ranked WHERE rn = 1
                ORDER BY created_at DESC
                LIMIT ${lim}
            `)
            const items = rawRows as Array<Record<string, unknown>>
            const nextCursor = items.length === lim ? (items[items.length - 1]?.['id'] as string ?? null) : null
            res.json({ items, nextCursor })
            return
        }

        // Default: flat list, newest first
        const items = cursor
            ? await db.select().from(conversations)
                .where(sql`workspace_id = ${workspaceId} AND id < ${cursor}`)
                .orderBy(desc(conversations.createdAt))
                .limit(lim)
            : await db.select().from(conversations)
                .where(sql`workspace_id = ${workspaceId}`)
                .orderBy(desc(conversations.createdAt))
                .limit(lim)

        const nextCursor = items.length === lim ? (items[items.length - 1]?.id ?? null) : null

        res.json({ items, nextCursor })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/conversations failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch conversations' } })
    }
})
