// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, desc, eq, sql, asc } from '@plexo/db'
import { conversations } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { graphCypher, isGraphSidecarConfigured } from '../lib/graph-sidecar.js'

export const conversationsRouter: RouterType = Router()


// ── Feature flag (Phase B2 / ADR 0021) ────────────────────────────────────────
// While we gate on a 7-day clean parity window, the SQL path stays default.
// FALKORDB_CONVERSATIONS=true flips reads to cypher per request.

function useCypher(): boolean {
    return process.env.FALKORDB_CONVERSATIONS === 'true' && isGraphSidecarConfigured()
}

// Header order returned by /v1/graph/cypher for `RETURN msg` etc.
function row(headers: string[], r: unknown[], key: string): unknown {
    const idx = headers.indexOf(key)
    return idx === -1 ? undefined : r[idx]
}

interface FalkorNode {
    labels?: string[]
    properties: Record<string, unknown>
    id?: number
}

function isFalkorNode(v: unknown): v is FalkorNode {
    return Boolean(v) && typeof v === 'object' && 'properties' in (v as Record<string, unknown>)
}

/** Project a FalkorDB Message node back to the postgres row shape the
 *  frontend expects (snake_case keys mapped to camelCase exactly as the
 *  SQL groupBySession path does today). */
function messageNodeToRow(n: FalkorNode, extras: Record<string, unknown> = {}): Record<string, unknown> {
    const p = n.properties
    return {
        id: p.id,
        workspaceId: p.workspace_id ?? null,
        sessionId: p.session_id ?? p.session ?? null,
        source: p.source,
        message: p.message,
        reply: p.reply ?? null,
        errorMsg: p.error_msg ?? null,
        status: p.status,
        intent: p.intent ?? null,
        taskId: p.task_id ?? null,
        channelRef: typeof p.channel_ref === 'string' ? safeJSON(p.channel_ref) : (p.channel_ref ?? null),
        attachments: typeof p.attachments === 'string' ? (safeJSON(p.attachments) ?? []) : (p.attachments ?? []),
        createdAt: p.created_at,
        ...extras,
    }
}

function safeJSON(s: string): unknown {
    try { return JSON.parse(s) } catch { return null }
}


// ── GET /api/v1/conversations/:id ─────────────────────────────────────────────
// Returns a single conversation record by its ID (ULID).

conversationsRouter.get('/:id', async (req, res) => {
    const { id } = req.params
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid id required (max 64 chars)' } })
        return
    }
    try {
        if (useCypher()) {
            // We need workspaceId to scope the cypher graph. Fetch from postgres
            // (cheap, indexed lookup) so the cypher query knows which graph DB to
            // target; then run cypher and trust the result.
            const [auth] = await db.select({ workspaceId: conversations.workspaceId })
                .from(conversations).where(eq(conversations.id, id)).limit(1)
            if (!auth) {
                res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } })
                return
            }
            if (!await ensureWorkspaceAccess(req, res, auth.workspaceId)) return
            const cy = await graphCypher({
                workspace_id: auth.workspaceId,
                cypher: 'MATCH (msg:Message {id: $id}) RETURN msg',
                params: { id },
            })
            if (!cy.rows.length || !isFalkorNode(cy.rows[0]?.[0])) {
                res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } })
                return
            }
            res.json(messageNodeToRow(cy.rows[0][0] as FalkorNode, { workspaceId: auth.workspaceId }))
            return
        }

        const [item] = await db.select().from(conversations)
            .where(eq(conversations.id, id))
            .limit(1)
        if (!item) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Conversation not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, item.workspaceId)) return
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
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const lim = Math.min(parseInt(limit, 10) || 50, 200)

        // Session thread view: all turns for a specific session ID (chronological)
        if (sessionId && sessionId.length > 64) {
            res.status(400).json({ error: { code: 'INVALID_SESSION', message: 'sessionId max 64 chars' } })
            return
        }
        if (sessionId) {
            if (useCypher()) {
                const cy = await graphCypher({
                    workspace_id: workspaceId,
                    cypher:
                        'MATCH (msg:Message)-[:IN_SESSION]->(session:Session {id: $sid}) ' +
                        'RETURN msg ' +
                        'ORDER BY msg.created_at ASC ' +
                        'LIMIT $lim',
                    params: { sid: sessionId, lim },
                })
                const items = cy.rows
                    .map(r => r[0])
                    .filter(isFalkorNode)
                    .map(n => messageNodeToRow(n, { workspaceId, sessionId }))
                res.json({ items, nextCursor: null, sessionId })
                return
            }
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
            if (useCypher()) {
                // Cypher equivalent of:
                //   ROW_NUMBER() OVER (PARTITION BY COALESCE(session_id,id) ORDER BY created_at DESC)
                //   COUNT(*) OVER (PARTITION BY COALESCE(session_id,id))
                // → group all Messages by their Session, pick latest, count siblings.
                // Cursor is interpreted as a Message id; we look up its created_at first
                // for parity with the SQL `< (SELECT created_at FROM conversations WHERE id = ${cursor})`.
                let cursorTs: string | null = null
                if (cursor) {
                    const cur = await graphCypher({
                        workspace_id: workspaceId,
                        cypher: 'MATCH (m:Message {id: $id}) RETURN m.created_at AS created_at',
                        params: { id: cursor },
                    })
                    if (cur.rows.length) {
                        cursorTs = cur.rows[0]?.[0] as string ?? null
                    }
                }
                const cy = await graphCypher({
                    workspace_id: workspaceId,
                    cypher:
                        'MATCH (msg:Message)-[:IN_SESSION]->(session:Session) ' +
                        (cursorTs ? 'WHERE msg.created_at < $cursor_ts ' : '') +
                        'WITH session, collect(msg) AS msgs ' +
                        'WITH session, msgs, ' +
                        '     reduce(latest = msgs[0], m IN msgs | ' +
                        '       CASE WHEN m.created_at > latest.created_at THEN m ELSE latest END) AS latest, ' +
                        '     size(msgs) AS turn_count ' +
                        'RETURN latest AS msg, turn_count ' +
                        'ORDER BY latest.created_at DESC ' +
                        'LIMIT $lim',
                    params: { lim, ...(cursorTs ? { cursor_ts: cursorTs } : {}) },
                })
                const items = cy.rows
                    .map(r => ({
                        node: row(cy.header, r, 'msg'),
                        turn_count: row(cy.header, r, 'turn_count'),
                    }))
                    .filter(x => isFalkorNode(x.node))
                    .map(x => messageNodeToRow(x.node as FalkorNode, {
                        workspaceId,
                        turn_count: x.turn_count,
                    }))
                const nextCursor = items.length === lim ? (items[items.length - 1]?.id as string ?? null) : null
                res.json({ items, nextCursor })
                return
            }
            // Use a window function to get the latest turn per session
            // plus a count of total turns per session.
            const rawRows = await db.execute(sql`
                WITH bounded AS (
                    SELECT * FROM conversations
                    WHERE workspace_id = ${workspaceId}
                    ${cursor ? sql`AND created_at < (SELECT created_at FROM conversations WHERE id = ${cursor})` : sql``}
                    ORDER BY created_at DESC
                    LIMIT 500
                ),
                ranked AS (
                    SELECT *,
                           ROW_NUMBER() OVER (PARTITION BY COALESCE(session_id, id) ORDER BY created_at DESC) AS rn,
                           COUNT(*) OVER (PARTITION BY COALESCE(session_id, id)) AS turn_count
                    FROM bounded
                )
                SELECT * FROM ranked WHERE rn = 1
                ORDER BY created_at DESC
                LIMIT ${lim}
            `)
            // Raw execute returns snake_case columns. Map them to camelCase to match the frontend ConversationItem type.
            const items = (rawRows as Array<Record<string, unknown>>).map((row) => ({
                id: row.id,
                workspaceId: row.workspace_id,
                sessionId: row.session_id,
                source: row.source,
                message: row.message,
                reply: row.reply,
                errorMsg: row.error_msg,
                status: row.status,
                intent: row.intent,
                taskId: row.task_id,
                channelRef: row.channel_ref,
                attachments: row.attachments,
                createdAt: row.created_at,
                turn_count: row.turn_count,
            }))
            const nextCursor = items.length === lim ? (items[items.length - 1]?.id as string ?? null) : null
            res.json({ items, nextCursor })
            return
        }

        // Default: flat list, newest first
        if (useCypher()) {
            // Cursor here is interpreted as "message id whose created_at bounds the page".
            // SQL path uses `id < ${cursor}` (ULID lexicographic ≈ time order). Cypher
            // mirrors with `msg.created_at < $cursor_ts` for an equivalent slice.
            let cursorTs: string | null = null
            if (cursor) {
                const cur = await graphCypher({
                    workspace_id: workspaceId,
                    cypher: 'MATCH (m:Message {id: $id}) RETURN m.created_at AS created_at',
                    params: { id: cursor },
                })
                if (cur.rows.length) {
                    cursorTs = cur.rows[0]?.[0] as string ?? null
                }
            }
            const cy = await graphCypher({
                workspace_id: workspaceId,
                cypher:
                    'MATCH (msg:Message)-[:IN_SESSION]->(s:Session) ' +
                    (cursorTs ? 'WHERE msg.created_at < $cursor_ts ' : '') +
                    'RETURN msg ' +
                    'ORDER BY msg.created_at DESC ' +
                    'LIMIT $lim',
                params: { lim, ...(cursorTs ? { cursor_ts: cursorTs } : {}) },
            })
            const items = cy.rows
                .map(r => r[0])
                .filter(isFalkorNode)
                .map(n => messageNodeToRow(n, { workspaceId }))
            const nextCursor = items.length === lim ? (items[items.length - 1]?.id as string ?? null) : null
            res.json({ items, nextCursor })
            return
        }

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
