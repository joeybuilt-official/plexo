// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Context Library API (Fabric §7.7).
 *
 * GET    /api/v1/context/:workspaceId              → list context blocks
 * POST   /api/v1/context/:workspaceId              → create user context
 * PATCH  /api/v1/context/:workspaceId/:contextId   → update context
 * DELETE /api/v1/context/:workspaceId/:contextId   → soft-delete user context
 * GET    /api/v1/context/:workspaceId/budget        → token budget utilization
 */

import { Router, type IRouter } from 'express'
import type { Request, Response } from 'express'
import { db, eq, and, isNull, sql } from '@plexo/db'
import { extensionContexts } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

/** Sentinel extension name for user-created contexts */
const USER_SENTINEL = '_user'
const MAX_CONTEXTS_PER_SOURCE = 10
const MAX_CONTENT_CHARS = 50_000
const MAX_NAME_CHARS = 100
const MAX_DESCRIPTION_CHARS = 500

export const contextRouter: IRouter = Router({ mergeParams: true })

/** Approximate token count: content length / 4 (GPT-family heuristic) */
function estimateTokens(content: string, declared?: number | null): number {
    return declared ?? Math.ceil(content.length / 4)
}

function badId(res: Response, param = 'workspaceId') {
    res.status(400).json({ error: { code: 'INVALID_ID', message: `${param} must be a valid UUID` } })
}

// ── GET / — list active context blocks (paginated) ───────────────────────────

contextRouter.get('/', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)

    const enabled = req.query['enabled'] as string | undefined
    const extensionName = req.query['extensionName'] as string | undefined
    const limit = Math.min(Number(req.query['limit'] ?? 50), 100)
    const offset = Number(req.query['offset'] ?? 0)

    try {
        const conditions = [
            eq(extensionContexts.workspaceId, workspaceId),
            isNull(extensionContexts.deletedAt),
        ]
        if (enabled === 'true') conditions.push(eq(extensionContexts.enabled, true))
        if (enabled === 'false') conditions.push(eq(extensionContexts.enabled, false))
        if (extensionName) conditions.push(eq(extensionContexts.extensionName, extensionName))

        const rows = await db
            .select()
            .from(extensionContexts)
            .where(and(...conditions))
            .orderBy(extensionContexts.priority, extensionContexts.extensionName)
            .limit(limit)
            .offset(offset)

        // Annotate with computed fields
        const items = rows.map((r) => {
            const tokens = estimateTokens(r.content, r.estimatedTokens)
            const expired = r.ttl != null && r.lastRefreshedAt != null
                ? (Date.now() - new Date(r.lastRefreshedAt).getTime()) / 1000 > r.ttl
                : false
            return { ...r, computedTokens: tokens, expired }
        })

        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /context failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list context' } })
    }
})

// ── POST / — create a user context block ─────────────────────────────────────

contextRouter.post('/', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)

    const { name, description, content, contentType, priority, ttl, tags } = req.body as {
        name?: string
        description?: string
        content?: string
        contentType?: string
        priority?: string
        ttl?: number
        tags?: string[]
    }

    if (!name || !content) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'name and content are required' } })
        return
    }
    if (name.length > MAX_NAME_CHARS) {
        res.status(400).json({ error: { code: 'NAME_TOO_LONG', message: `name must be ${MAX_NAME_CHARS} chars or fewer` } })
        return
    }
    if (description && description.length > MAX_DESCRIPTION_CHARS) {
        res.status(400).json({ error: { code: 'DESCRIPTION_TOO_LONG', message: `description must be ${MAX_DESCRIPTION_CHARS} chars or fewer` } })
        return
    }
    if (content.length > MAX_CONTENT_CHARS) {
        res.status(400).json({ error: { code: 'CONTENT_TOO_LARGE', message: `content must be ${MAX_CONTENT_CHARS} chars or fewer` } })
        return
    }

    try {
        // Enforce 10-context cap per user
        const [countRow] = await db.select({ count: sql<number>`count(*)` })
            .from(extensionContexts)
            .where(and(
                eq(extensionContexts.workspaceId, workspaceId),
                eq(extensionContexts.extensionName, USER_SENTINEL),
                isNull(extensionContexts.deletedAt),
            ))
        if (Number(countRow?.count ?? 0) >= MAX_CONTEXTS_PER_SOURCE) {
            res.status(400).json({ error: { code: 'CONTEXT_LIMIT', message: `Maximum ${MAX_CONTEXTS_PER_SOURCE} user contexts allowed` } })
            return
        }

        const contextId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || crypto.randomUUID()
        const validPriorities = ['low', 'normal', 'high', 'critical']
        const resolvedPriority = (priority && validPriorities.includes(priority) ? priority : 'normal') as 'low' | 'normal' | 'high' | 'critical'

        const [row] = await db.insert(extensionContexts).values({
            workspaceId,
            extensionName: USER_SENTINEL,
            contextId,
            name,
            description: description ?? '',
            content,
            contentType: contentType ?? 'text/plain',
            priority: resolvedPriority,
            ttl: ttl ?? null,
            tags: Array.isArray(tags) ? tags.map(String).slice(0, 10) : [],
            estimatedTokens: Math.ceil(content.length / 4),
            enabled: true,
        }).onConflictDoNothing().returning()

        if (!row) {
            res.status(409).json({ error: { code: 'DUPLICATE', message: 'A context with this name already exists' } })
            return
        }

        logger.info({ workspaceId, contextId, name }, 'User context created')
        res.status(201).json({ ...row, computedTokens: estimateTokens(content, row.estimatedTokens) })
    } catch (err) {
        logger.error({ err }, 'POST /context failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create context' } })
    }
})

// ── DELETE /:contextId — soft-delete a user context ──────────────────────────

contextRouter.delete('/:contextId', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    const contextId = req.params['contextId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    if (!UUID_RE.test(contextId)) return void badId(res, 'contextId')

    try {
        const [existing] = await db.select({ extensionName: extensionContexts.extensionName })
            .from(extensionContexts)
            .where(and(
                eq(extensionContexts.id, contextId),
                eq(extensionContexts.workspaceId, workspaceId),
                isNull(extensionContexts.deletedAt),
            ))
            .limit(1)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Context block not found' } })
            return
        }
        if (existing.extensionName !== USER_SENTINEL) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Extension contexts are managed by the extension lifecycle — disable instead' } })
            return
        }

        await db.update(extensionContexts)
            .set({ deletedAt: new Date(), updatedAt: new Date() })
            .where(eq(extensionContexts.id, contextId))

        logger.info({ workspaceId, contextId }, 'User context deleted')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE /context/:contextId failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Delete failed' } })
    }
})

// ── PATCH /:contextId — enable/disable, override priority ────────────────────

contextRouter.patch('/:contextId', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    const contextId = req.params['contextId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    if (!UUID_RE.test(contextId)) return void badId(res, 'contextId')

    const { enabled, priority, content, name, description, contentType, tags, ttl } = req.body as {
        enabled?: boolean
        priority?: 'low' | 'normal' | 'high' | 'critical'
        content?: string
        name?: string
        description?: string
        contentType?: string
        tags?: string[]
        ttl?: number | null
    }

    try {
        const [existing] = await db
            .select()
            .from(extensionContexts)
            .where(and(
                eq(extensionContexts.id, contextId),
                eq(extensionContexts.workspaceId, workspaceId),
                isNull(extensionContexts.deletedAt),
            ))
            .limit(1)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Context block not found' } })
            return
        }

        // Validate content length
        if (content && content.length > MAX_CONTENT_CHARS) {
            res.status(400).json({ error: { code: 'CONTENT_TOO_LARGE', message: `content must be ${MAX_CONTENT_CHARS} chars or fewer` } })
            return
        }
        if (name && name.length > MAX_NAME_CHARS) {
            res.status(400).json({ error: { code: 'NAME_TOO_LONG', message: `name must be ${MAX_NAME_CHARS} chars or fewer` } })
            return
        }

        const validPriorities = ['low', 'normal', 'high', 'critical']
        const update: Record<string, unknown> = { updatedAt: new Date() }
        if (typeof enabled === 'boolean') update.enabled = enabled
        if (priority && validPriorities.includes(priority)) update.priority = priority

        // User contexts support full content editing
        if (existing.extensionName === USER_SENTINEL) {
            if (content !== undefined) {
                update.content = content
                update.lastRefreshedAt = new Date()
                update.estimatedTokens = Math.ceil(content.length / 4)
            }
            if (name !== undefined) update.name = name
            if (description !== undefined) update.description = description
            if (contentType !== undefined) update.contentType = contentType
            if (tags !== undefined) update.tags = Array.isArray(tags) ? tags.map(String).slice(0, 10) : []
            if (ttl !== undefined) update.ttl = ttl
        }

        await db.update(extensionContexts).set(update).where(eq(extensionContexts.id, contextId))

        logger.info({ contextId, workspaceId, isUser: existing.extensionName === USER_SENTINEL }, 'Context updated')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'PATCH /context/:contextId failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── GET /budget — token budget utilization summary ───────────────────────────

contextRouter.get('/budget', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)

    try {
        const rows = await db
            .select()
            .from(extensionContexts)
            .where(and(
                eq(extensionContexts.workspaceId, workspaceId),
                eq(extensionContexts.enabled, true),
                isNull(extensionContexts.deletedAt),
            ))

        // Filter out expired context
        const now = Date.now()
        const active = rows.filter((r) => {
            if (r.ttl == null || r.lastRefreshedAt == null) return true
            return (now - new Date(r.lastRefreshedAt).getTime()) / 1000 <= r.ttl
        })

        // Group by extension for per-extension breakdown
        const byExtension: Record<string, { tokens: number; count: number }> = {}
        let totalTokens = 0

        for (const r of active) {
            const tokens = estimateTokens(r.content, r.estimatedTokens)
            totalTokens += tokens
            if (!byExtension[r.extensionName]) {
                byExtension[r.extensionName] = { tokens: 0, count: 0 }
            }
            byExtension[r.extensionName]!.tokens += tokens
            byExtension[r.extensionName]!.count += 1
        }

        res.json({
            totalTokens,
            activeContextCount: active.length,
            byExtension,
            // Default budget: 40% of a 128k context window = ~51,200 tokens for extensions
            budgetLimit: 51200,
            utilization: totalTokens / 51200,
        })
    } catch (err) {
        logger.error({ err }, 'GET /context/budget failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Budget query failed' } })
    }
})
