// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP Resources — Phase 4
 *
 * Resources expose read-only, URI-addressed data to MCP clients.
 * Clients can list resources and read specific URIs.
 *
 * workspace://tasks/recent   — last 10 tasks for the workspace
 * workspace://memory/recent  — last 10 memory entries
 * workspace://stats          — cost + agent summary
 */
import { db, sql } from '@plexo/db'
import type { McpContext } from '../types.js'

export interface ResourceDefinition {
    uri: string
    name: string
    description: string
    mimeType: string
    /** Minimum scope required to read this resource */
    scope: string
}

export const resourceDefinitions: ResourceDefinition[] = [
    {
        uri: 'workspace://tasks/recent',
        name: 'Recent Tasks',
        description: 'The 10 most recently created tasks in this workspace.',
        mimeType: 'application/json',
        scope: 'tasks:read',
    },
    {
        uri: 'workspace://memory/recent',
        name: 'Recent Memory Entries',
        description: 'The 10 most recently stored memory entries for this workspace.',
        mimeType: 'application/json',
        scope: 'memory:read',
    },
    {
        uri: 'workspace://stats',
        name: 'Workspace Stats',
        description: 'Agent status, weekly cost usage, and task counts.',
        mimeType: 'application/json',
        scope: 'system:read',
    },
]

export async function readResource(uri: string, ctx: McpContext): Promise<string> {
    if (uri === 'workspace://tasks/recent') {
        const rows = await db.execute<{
            id: string
            type: string
            status: string
            request: string | null
            created_at: string
        }>(sql`
            SELECT id, type, status, request, created_at
            FROM tasks
            WHERE workspace_id = ${ctx.workspace_id}
            ORDER BY created_at DESC
            LIMIT 10
        `)
        return JSON.stringify({ tasks: rows }, null, 2)
    }

    if (uri === 'workspace://memory/recent') {
        const rows = await db.execute<{
            id: string
            content: string
            type: string
            created_at: string
        }>(sql`
            SELECT id, content, type, created_at
            FROM memory_entries
            WHERE workspace_id = ${ctx.workspace_id}
            ORDER BY created_at DESC
            LIMIT 10
        `)
        return JSON.stringify({ entries: rows }, null, 2)
    }

    if (uri === 'workspace://stats') {
        const [cost] = await db.execute<{ week_cost: string; ceiling: string }>(sql`
            SELECT
                COALESCE(SUM(CASE WHEN week_start >= date_trunc('week', NOW())::date THEN cost_usd END), 0)::text AS week_cost,
                COALESCE(MAX(ceiling_usd), 10)::text AS ceiling
            FROM api_cost_tracking
            WHERE workspace_id = ${ctx.workspace_id}
        `)
        const [taskCounts] = await db.execute<{ running: string; queued: string; completed: string }>(sql`
            SELECT
                COUNT(*) FILTER (WHERE status = 'running')::text AS running,
                COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
                COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
            FROM tasks
            WHERE workspace_id = ${ctx.workspace_id}
        `)
        return JSON.stringify({
            weekly_cost_usd: parseFloat(cost?.week_cost ?? '0'),
            weekly_ceiling_usd: parseFloat(cost?.ceiling ?? '10'),
            tasks: {
                running: parseInt(taskCounts?.running ?? '0', 10),
                queued: parseInt(taskCounts?.queued ?? '0', 10),
                completed: parseInt(taskCounts?.completed ?? '0', 10),
            },
        }, null, 2)
    }

    throw new Error(`Unknown resource URI: ${uri}`)
}
