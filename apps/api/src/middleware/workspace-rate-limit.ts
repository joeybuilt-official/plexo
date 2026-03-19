// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace-scoped rate limiting
 *
 * Per-workspace request budgets enforced via Redis sliding-window counters.
 * Reads workspace.settings.rateLimit.requestsPerHour — falls back to 1000.
 *
 * Redis key: ws_rate:{workspaceId}  TTL = 1 hour
 * Uses INCR + EXPIRE atomic pattern (single-instance safe).
 *
 * Usage:
 *   import { workspaceRateLimit } from '../middleware/workspace-rate-limit.js'
 *   v1.use('/tasks', workspaceRateLimit, tasksRouter)
 *
 * Reads workspaceId from: req.body.workspaceId, req.query.workspaceId
 * If no workspaceId provided, passes through (IP-based limiter still applies).
 */
import type { Request, Response, NextFunction } from 'express'
import { getRedis } from '../redis-client.js'
import { db, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import pino from 'pino'

const logger = pino({ name: 'ws-rate-limit' })
const DEFAULT_LIMIT = 1000  // requests per hour if not configured
const WINDOW_SECS = 3600    // 1 hour

interface WorkspaceSettings {
    rateLimit?: {
        requestsPerHour?: number
    }
}

export async function workspaceRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const body = req.body as Record<string, unknown> | undefined
    const wsId: string | undefined =
        (typeof body?.workspaceId === 'string' ? body.workspaceId : undefined) ??
        (typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined)

    // No workspace context — let IP-based limiter handle it
    if (!wsId) {
        next()
        return
    }

    try {
        const redis = await getRedis()
        const key = `ws_rate:${wsId}`

        const count = await redis.incr(key)

        // First request in window — start the TTL
        if (count === 1) {
            await redis.expire(key, WINDOW_SECS)
        }

        const limitKey = `ws_rate_limit:${wsId}`
        let limit = DEFAULT_LIMIT

        const cached = await redis.get(limitKey)
        if (cached) {
            limit = parseInt(cached, 10) || DEFAULT_LIMIT
        } else {
            try {
                const [ws] = await db
                    .select({ settings: workspaces.settings })
                    .from(workspaces)
                    .where(eq(workspaces.id, wsId))
                    .limit(1)

                const settings = (ws?.settings ?? {}) as WorkspaceSettings
                limit = settings.rateLimit?.requestsPerHour ?? DEFAULT_LIMIT
                await redis.set(limitKey, String(limit), { EX: 60 })
            } catch { /* DB unavailable — use default */
                limit = DEFAULT_LIMIT
            }
        }

        res.setHeader('X-Workspace-RateLimit-Limit', limit)
        res.setHeader('X-Workspace-RateLimit-Remaining', Math.max(0, limit - count))

        if (count > limit) {
            logger.warn({ wsId, count, limit }, 'Workspace rate limit exceeded')
            res.status(429).json({
                error: {
                    code: 'WORKSPACE_RATE_LIMITED',
                    message: `Workspace request limit of ${limit}/hour exceeded. Configure in Settings › Agent.`,
                },
            })
            return
        }
    } catch (err) {
        // Redis unavailable — degrade gracefully, don't block requests
        logger.error({ err }, 'workspaceRateLimit: Redis error — skipping check')
    }

    next()
}
