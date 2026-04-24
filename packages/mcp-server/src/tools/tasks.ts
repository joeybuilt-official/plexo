// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP Task tools — Phase 4
 *
 * plexo_list_tasks   — list recent tasks for a workspace (tasks:read)
 * plexo_create_task  — create a new task (tasks:write)
 * plexo_cancel_task  — cancel a queued/running task (tasks:write)
 * plexo_get_task     — get a single task by ID (tasks:read)
 */
import { z } from 'zod'
import { db, sql } from '@plexo/db'
import { ulid } from 'ulid'
import type { McpContext } from '../types.js'
import { scopeDenied, internalError } from '../errors.js'
import { requireScope } from '../auth.js'
import { logger } from '../logger.js'

// ── plexo_list_tasks ──────────────────────────────────────────────────────────

export const listTasksInputSchema = z.object({
    limit: z.number().int().min(1).max(50).optional().default(20),
    status: z.enum(['queued', 'claimed', 'running', 'completed', 'failed', 'cancelled']).optional(),
}).strict()

export async function plexoListTasks(
    input: z.infer<typeof listTasksInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'tasks:read')) return scopeDenied('tasks:read')

    try {
        const rows = await db.execute<{
            id: string
            type: string
            status: string
            request: string | null
            created_at: string
            completed_at: string | null
            cost_usd: string | null
        }>(sql`
            SELECT id, type, status, request, created_at, completed_at, cost_usd::text
            FROM tasks
            WHERE workspace_id = ${ctx.workspace_id}
            ${input.status ? sql`AND status = ${input.status}` : sql``}
            ORDER BY created_at DESC
            LIMIT ${input.limit}
        `)

        logger.info({ event: 'mcp_tool_call', tool_name: 'plexo_list_tasks', token_id: ctx.token_id, workspace_id: ctx.workspace_id }, 'plexo_list_tasks called')

        return {
            tasks: rows.map((r) => ({
                id: r.id,
                type: r.type,
                status: r.status,
                request: r.request?.slice(0, 200) ?? null,
                created_at: r.created_at,
                completed_at: r.completed_at,
                cost_usd: r.cost_usd ? parseFloat(r.cost_usd) : null,
            })),
            total: rows.length,
        }
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_list_tasks failed')
        return internalError(corrId)
    }
}

// ── plexo_create_task ─────────────────────────────────────────────────────────

const VALID_TYPES = ['general', 'research', 'coding', 'automation', 'analysis', 'writing'] as const

export const createTaskInputSchema = z.object({
    type: z.enum(VALID_TYPES).optional().default('general'),
    request: z.string().min(1).max(4000),
    project_id: z.string().uuid().optional(),
}).strict()

export async function plexoCreateTask(
    input: z.infer<typeof createTaskInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'tasks:write')) return scopeDenied('tasks:write')

    try {
        const id = ulid()

        await db.execute(sql`
            INSERT INTO tasks (id, workspace_id, type, status, source, request, project_id, created_at, updated_at)
            VALUES (
                ${id},
                ${ctx.workspace_id},
                ${input.type},
                'queued',
                'mcp',
                ${input.request},
                ${input.project_id ?? null},
                NOW(),
                NOW()
            )
        `)

        logger.info({ event: 'mcp_tool_call', tool_name: 'plexo_create_task', token_id: ctx.token_id, workspace_id: ctx.workspace_id, task_id: id }, 'plexo_create_task called')

        return {
            id,
            type: input.type,
            status: 'queued',
            request: input.request,
            created_at: new Date().toISOString(),
            message: 'Task queued. The agent will pick it up shortly.',
        }
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_create_task failed')
        return internalError(corrId)
    }
}

// ── plexo_get_task ────────────────────────────────────────────────────────────

export const getTaskInputSchema = z.object({
    task_id: z.string().min(1),
}).strict()

export async function plexoGetTask(
    input: z.infer<typeof getTaskInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'tasks:read')) return scopeDenied('tasks:read')

    try {
        const [row] = await db.execute<{
            id: string
            type: string
            status: string
            request: string | null
            result: string | null
            created_at: string
            completed_at: string | null
            cost_usd: string | null
            workspace_id: string
        }>(sql`
            SELECT id, type, status, request, result, created_at, completed_at, cost_usd::text, workspace_id
            FROM tasks
            WHERE id = ${input.task_id}
            LIMIT 1
        `)

        if (!row) {
            return { error: 'Task not found', code: 'NOT_FOUND', correlation_id: crypto.randomUUID() }
        }

        // Workspace isolation
        if (row.workspace_id !== ctx.workspace_id) {
            return scopeDenied('tasks:read')
        }

        return {
            id: row.id,
            type: row.type,
            status: row.status,
            request: row.request?.slice(0, 500) ?? null,
            result: row.result?.slice(0, 2000) ?? null,
            created_at: row.created_at,
            completed_at: row.completed_at,
            cost_usd: row.cost_usd ? parseFloat(row.cost_usd) : null,
        }
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_get_task failed')
        return internalError(corrId)
    }
}

// ── plexo_cancel_task ─────────────────────────────────────────────────────────

export const cancelTaskInputSchema = z.object({
    task_id: z.string().min(1),
}).strict()

export async function plexoCancelTask(
    input: z.infer<typeof cancelTaskInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'tasks:write')) return scopeDenied('tasks:write')

    try {
        const result = await db.execute(sql`
            UPDATE tasks
            SET status = 'cancelled', updated_at = NOW()
            WHERE id = ${input.task_id}
              AND workspace_id = ${ctx.workspace_id}
              AND status IN ('queued', 'claimed', 'running', 'pending')
            RETURNING id
        `)

        if (!result.length) {
            return { error: 'Task not found or already in terminal state', code: 'NOT_CANCELABLE', correlation_id: crypto.randomUUID() }
        }

        logger.info({ event: 'mcp_tool_call', tool_name: 'plexo_cancel_task', token_id: ctx.token_id, task_id: input.task_id }, 'plexo_cancel_task called')
        return { ok: true, task_id: input.task_id, status: 'cancelled' }
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_cancel_task failed')
        return internalError(corrId)
    }
}
