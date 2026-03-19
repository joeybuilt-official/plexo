// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * System tools — Phase 1
 *
 * plexo_health    - no auth required, returns system health
 * plexo_workspace_info - requires system:read scope
 */
import { z } from 'zod'
import { db, sql, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import type { McpContext } from '../types.js'
import { scopeDenied, internalError } from '../errors.js'
import { requireScope } from '../auth.js'
import { logger } from '../logger.js'

// ── plexo_health ──────────────────────────────────────────────────────────────

export const healthInputSchema = z.object({}).strict()

export async function plexoHealth(_input: z.infer<typeof healthInputSchema>): Promise<unknown> {
    const result = {
        status: 'ok' as 'ok' | 'degraded' | 'down',
        db: false,
        redis: false,
        agent: false,
        timestamp: new Date().toISOString(),
    }

    try {
        await db.execute(sql`SELECT 1`)
        result.db = true
    } catch {
        result.status = 'degraded'
    }

    try {
        const { createClient } = await import('redis')
        const client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
        await client.connect()
        await client.ping()
        await client.disconnect()
        result.redis = true
    } catch {
        result.status = 'degraded'
    }

    // Agent liveness: if the tasks table is queryable, agent infra is up
    try {
        await db.execute(sql`SELECT COUNT(*) FROM tasks WHERE status = 'running'`)
        result.agent = true
    } catch {
        // Non-critical: agent check failure doesn't degrade overall health
    }

    if (!result.db) result.status = 'down'

    return result
}

// ── plexo_workspace_info ──────────────────────────────────────────────────────

export const workspaceInfoInputSchema = z.object({}).strict()

export async function plexoWorkspaceInfo(
    _input: z.infer<typeof workspaceInfoInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'system:read')) {
        return scopeDenied('system:read')
    }

    try {
        const [workspace] = await db
            .select({ name: workspaces.name })
            .from(workspaces)
            .where(eq(workspaces.id, ctx.workspace_id))
            .limit(1)

        if (!workspace) {
            return internalError()
        }

        // Active task count
        const [taskCountRow] = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*)::text as count
            FROM tasks
            WHERE workspace_id = ${ctx.workspace_id}
              AND status IN ('queued', 'claimed', 'running')
        `)

        // API cost this week
        const [costRow] = await db.execute<{ week: string; ceiling: string }>(sql`
            SELECT
                COALESCE(SUM(CASE WHEN created_at > NOW() - INTERVAL '7 days' THEN cost_usd ELSE 0 END), 0)::text as week,
                COALESCE(MAX(ceiling_usd), 10)::text as ceiling
            FROM api_cost_tracking
            WHERE workspace_id = ${ctx.workspace_id}
            LIMIT 1
        `)

        // Connected channels
        const [channelCountRow] = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*)::text as count
            FROM channels
            WHERE workspace_id = ${ctx.workspace_id}
              AND enabled = true
        `)

        // Installed connections (non-MCP)
        const [connCountRow] = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*)::text as count
            FROM installed_connections
            WHERE workspace_id = ${ctx.workspace_id}
        `)

        // Plugin count
        const [pluginCountRow] = await db.execute<{ count: string }>(sql`
            SELECT COUNT(*)::text as count
            FROM plugins
            WHERE workspace_id = ${ctx.workspace_id}
              AND enabled = true
        `)

        logger.info({
            event: 'mcp_tool_call',
            tool_name: 'plexo_workspace_info',
            token_id: ctx.token_id,
            workspace_id: ctx.workspace_id,
            scopes_used: ['system:read'],
            success: true,
        }, 'plexo_workspace_info called')

        return {
            workspace_name: workspace.name,
            // Agent status: 'idle' until we wire real agent status checks
            agent_status: 'idle',
            active_task_count: parseInt(taskCountRow?.count ?? '0', 10),
            api_cost_this_week: parseFloat(costRow?.week ?? '0'),
            api_cost_ceiling: parseFloat(costRow?.ceiling ?? '10'),
            connected_channels_count: parseInt(channelCountRow?.count ?? '0', 10),
            connection_count: parseInt(connCountRow?.count ?? '0', 10),
            plugin_count: parseInt(pluginCountRow?.count ?? '0', 10),
        }
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId, token_id: ctx.token_id }, 'plexo_workspace_info failed')
        return internalError(corrId)
    }
}
