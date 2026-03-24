// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension Context Layer API (Kapsel §7.7).
 *
 * GET    /api/v1/context/:workspaceId              → list context blocks
 * PATCH  /api/v1/context/:workspaceId/:contextId   → enable/disable, override priority
 * GET    /api/v1/context/:workspaceId/budget        → token budget utilization
 */

import { Router, type IRouter } from 'express'
import type { Request, Response } from 'express'
import { db, eq, and, isNull } from '@plexo/db'
import { extensionContexts } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

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

// ── PATCH /:contextId — enable/disable, override priority ────────────────────

contextRouter.patch('/:contextId', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    const contextId = req.params['contextId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    if (!UUID_RE.test(contextId)) return void badId(res, 'contextId')

    const { enabled, priority } = req.body as {
        enabled?: boolean
        priority?: 'low' | 'normal' | 'high' | 'critical'
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

        const validPriorities = ['low', 'normal', 'high', 'critical']
        const update: Record<string, unknown> = { updatedAt: new Date() }
        if (typeof enabled === 'boolean') update.enabled = enabled
        if (priority && validPriorities.includes(priority)) update.priority = priority

        await db.update(extensionContexts).set(update).where(eq(extensionContexts.id, contextId))

        logger.info({ contextId, enabled, priority, workspaceId }, 'Extension context updated')
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
