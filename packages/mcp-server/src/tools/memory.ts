// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP Memory tools — Phase 4
 *
 * plexo_search_memory  — semantic search over workspace memory (memory:read)
 * plexo_remember       — store a fact/instruction in workspace memory (memory:write)
 */
import { z } from 'zod'
import { db, sql } from '@plexo/db'
import type { McpContext } from '../types.js'
import { scopeDenied, internalError } from '../errors.js'
import { requireScope } from '../auth.js'
import { logger } from '../logger.js'

// ── plexo_search_memory ───────────────────────────────────────────────────────

export const searchMemoryInputSchema = z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(20).optional().default(5),
}).strict()

export async function plexoSearchMemory(
    input: z.infer<typeof searchMemoryInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'memory:read')) return scopeDenied('memory:read')

    try {
        // ILIKE text fallback (works without OpenAI embedding)
        const rows = await db.execute<{
            id: string
            content: string
            type: string
            created_at: string
            relevance: string | null
        }>(sql`
            SELECT id, content, type, created_at, NULL as relevance
            FROM memory_entries
            WHERE workspace_id = ${ctx.workspace_id}
              AND content ILIKE ${'%' + input.query + '%'}
            ORDER BY created_at DESC
            LIMIT ${input.limit}
        `)

        logger.info({ event: 'mcp_tool_call', tool_name: 'plexo_search_memory', token_id: ctx.token_id, query: input.query.slice(0, 50) }, 'plexo_search_memory called')

        return {
            results: rows.map((r) => ({
                id: r.id,
                content: r.content,
                type: r.type,
                created_at: r.created_at,
            })),
            total: rows.length,
            note: 'Results are text-matched. Semantic search requires OpenAI embedding key configured.',
        }
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_search_memory failed')
        return internalError(corrId)
    }
}

// ── plexo_remember ────────────────────────────────────────────────────────────

export const rememberInputSchema = z.object({
    content: z.string().min(1).max(2000),
    type: z.enum(['fact', 'pattern', 'preference', 'task']).optional().default('fact'),
}).strict()

export async function plexoRemember(
    input: z.infer<typeof rememberInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'memory:write')) return scopeDenied('memory:write')

    try {
        const id = crypto.randomUUID()

        await db.execute(sql`
            INSERT INTO memory_entries (id, workspace_id, content, type, source, created_at)
            VALUES (
                ${id},
                ${ctx.workspace_id},
                ${input.content},
                ${input.type},
                'mcp',
                NOW()
            )
        `)

        logger.info({ event: 'mcp_tool_call', tool_name: 'plexo_remember', token_id: ctx.token_id, type: input.type }, 'plexo_remember called')

        return {
            ok: true,
            id,
            content: input.content,
            type: input.type,
            message: 'Memory stored. The agent will use this in future tasks.',
        }
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_remember failed')
        return internalError(corrId)
    }
}
