// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Debug API routes — admin-only, never public
 *
 * GET  /api/debug/snapshot  — agent runtime state, queue depth, active connections
 * POST /api/debug/rpc       — pass-through method call to agent runtime
 */
import { Router, type Router as RouterType } from 'express'
import { db, sql } from '@plexo/db'
import { connectedCount } from '../sse-emitter.js'
import { logger } from '../logger.js'

export const debugRouter: RouterType = Router()

// ── GET /api/debug/snapshot ───────────────────────────────────────────────────

debugRouter.get('/snapshot', async (_req, res) => {
    try {
        // Query queue state
        const [queueStats] = await db.execute<{
            running: string
            queued: string
            total: string
        }>(sql`
            SELECT
                COUNT(*) FILTER (WHERE status = 'running') AS running,
                COUNT(*) FILTER (WHERE status = 'queued')  AS queued,
                COUNT(*)                                   AS total
            FROM tasks
        `)

        const [sprintStats] = await db.execute<{
            pending: string
            in_progress: string
            total: string
        }>(sql`
            SELECT
                COUNT(*) FILTER (WHERE status = 'queued')   AS pending,
                COUNT(*) FILTER (WHERE status = 'running')  AS in_progress,
                COUNT(*)                                    AS total
            FROM sprint_tasks
        `)

        const [ledgerStats] = await db.execute<{
            rows: string
            avg_quality: string | null
            total_tokens: string
        }>(sql`
            SELECT
                COUNT(*)            AS rows,
                AVG(quality_score)  AS avg_quality,
                SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS total_tokens
            FROM work_ledger
            WHERE completed_at > NOW() - INTERVAL '7 days'
        `)

        const snapshot = {
            timestamp: new Date().toISOString(),
            sse: {
                connectedClients: connectedCount(),
            },
            taskQueue: {
                running: Number(queueStats?.running ?? 0),
                queued: Number(queueStats?.queued ?? 0),
                total: Number(queueStats?.total ?? 0),
            },
            sprintTasks: {
                pending: Number(sprintStats?.pending ?? 0),
                inProgress: Number(sprintStats?.in_progress ?? 0),
                total: Number(sprintStats?.total ?? 0),
            },
            workLedger7d: {
                entries: Number(ledgerStats?.rows ?? 0),
                avgQuality: ledgerStats?.avg_quality != null ? Number(ledgerStats.avg_quality).toFixed(3) : null,
                totalTokens: Number(ledgerStats?.total_tokens ?? 0),
            },
            process: {
                uptime: Math.floor(process.uptime()),
                memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                nodeVersion: process.version,
                pid: process.pid,
            },
        }

        res.json(snapshot)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err }, 'GET /api/debug/snapshot failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: msg } })
    }
})

// ── POST /api/debug/rpc ───────────────────────────────────────────────────────
// Pass a method name + params JSON through to a known set of safe debug operations.
// Not a general-purpose eval — explicitly allowlisted methods only.

const ALLOWED_METHODS = [
    'ping',
    'queue.stats',
    'memory.list',
    'memory.run_improvement',
    'agent.status',
] as const

type AllowedMethod = typeof ALLOWED_METHODS[number]

debugRouter.post('/rpc', async (req, res) => {
    const { method, params = {} } = req.body as { method?: string; params?: Record<string, unknown> }

    if (!method) {
        res.status(400).json({ error: { code: 'MISSING_METHOD', message: 'method required' } })
        return
    }

    if (!ALLOWED_METHODS.includes(method as AllowedMethod)) {
        res.status(400).json({
            error: {
                code: 'METHOD_NOT_ALLOWED',
                message: `Method "${method}" not in allowlist`,
                allowed: ALLOWED_METHODS,
            },
        })
        return
    }

    const start = Date.now()

    try {
        let result: unknown

        switch (method as AllowedMethod) {
            case 'ping': {
                result = { pong: true, timestamp: new Date().toISOString() }
                break
            }
            case 'queue.stats': {
                const [stats] = await db.execute<{ running: string; queued: string }>(sql`
                    SELECT
                        COUNT(*) FILTER (WHERE status = 'running') AS running,
                        COUNT(*) FILTER (WHERE status = 'queued')  AS queued
                    FROM tasks
                `)
                result = { running: Number(stats?.running ?? 0), queued: Number(stats?.queued ?? 0) }
                break
            }
            case 'memory.list': {
                const rows = await db.execute<{ id: string; pattern_type: string; description: string; created_at: Date }>(sql`
                    SELECT id, pattern_type, description, created_at
                    FROM agent_improvement_log
                    ORDER BY created_at DESC
                    LIMIT 10
                `)
                result = { improvements: rows }
                break
            }
            case 'memory.run_improvement': {
                const workspaceId = params.workspaceId as string | undefined
                if (!workspaceId) {
                    res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'params.workspaceId required' } })
                    return
                }
                // Defer to the memory API endpoint rather than importing to avoid circular dep
                result = { message: `Improvement cycle queued for workspace ${workspaceId}. Call POST /api/memory/improvements/run to execute.` }
                break
            }
            case 'agent.status': {
                result = {
                    connectedClients: connectedCount(),
                    uptime: Math.floor(process.uptime()),
                    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
                }
                break
            }
        }

        res.json({
            method,
            params,
            result,
            latencyMs: Date.now() - start,
        })
    } catch (err: unknown) {
        logger.error({ err, method }, 'POST /api/debug/rpc failed')
        res.status(500).json({ error: { code: 'RPC_ERROR', message: (err as Error).message } })
    }
})
