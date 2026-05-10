// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP PAX tools — PAX Protocol §11
 *
 * plexo_pax_register  — register a PAX app from manifest JSON (pax:manage)
 * plexo_pax_status    — get registration status for an app (pax:read)
 * plexo_pax_revoke    — revoke a PAX app registration (pax:manage)
 */
import { z } from 'zod'
import type { McpContext } from '../types.js'
import { scopeDenied, internalError, mcpError } from '../errors.js'
import { requireScope } from '../auth.js'
import { logger } from '../logger.js'

const API_BASE = process.env.PLEXO_API_URL ?? process.env.PUBLIC_URL ?? 'http://localhost:3001'

// ── plexo_pax_register ───────────────────────────────────────────────────────

export const paxRegisterInputSchema = z.object({
    manifest_json: z.string().min(2).max(10000),
}).strict()

export async function plexoPaxRegister(
    input: z.infer<typeof paxRegisterInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'pax:manage')) return scopeDenied('pax:manage')

    try {
        let manifest: unknown
        try {
            manifest = JSON.parse(input.manifest_json)
        } catch {
            return mcpError('Invalid JSON in manifest_json', 'INVALID_INPUT')
        }

        const res = await fetch(`${API_BASE}/api/v1/pax/register`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-workspace-id': ctx.workspace_id,
            },
            body: JSON.stringify({ manifest }),
        })

        const body = await res.json() as Record<string, unknown>

        logger.info({
            event: 'mcp_tool_call',
            tool_name: 'plexo_pax_register',
            token_id: ctx.token_id,
            status: res.status,
        }, 'plexo_pax_register called')

        return body
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_pax_register failed')
        return internalError(corrId)
    }
}

// ── plexo_pax_status ─────────────────────────────────────────────────────────

export const paxStatusInputSchema = z.object({
    app_name: z.string().min(1).max(128),
}).strict()

export async function plexoPaxStatus(
    input: z.infer<typeof paxStatusInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'pax:read')) return scopeDenied('pax:read')

    try {
        const res = await fetch(`${API_BASE}/api/v1/pax/status/${encodeURIComponent(input.app_name)}`, {
            method: 'GET',
            headers: {
                'x-workspace-id': ctx.workspace_id,
            },
        })

        const body = await res.json() as Record<string, unknown>

        logger.info({
            event: 'mcp_tool_call',
            tool_name: 'plexo_pax_status',
            token_id: ctx.token_id,
            app_name: input.app_name,
        }, 'plexo_pax_status called')

        return body
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_pax_status failed')
        return internalError(corrId)
    }
}

// ── plexo_pax_revoke ─────────────────────────────────────────────────────────

export const paxRevokeInputSchema = z.object({
    app_name: z.string().min(1).max(128),
}).strict()

export async function plexoPaxRevoke(
    input: z.infer<typeof paxRevokeInputSchema>,
    ctx: McpContext,
): Promise<unknown> {
    if (!requireScope(ctx, 'pax:manage')) return scopeDenied('pax:manage')

    try {
        const res = await fetch(`${API_BASE}/api/v1/pax/register/${encodeURIComponent(input.app_name)}`, {
            method: 'DELETE',
            headers: {
                'x-workspace-id': ctx.workspace_id,
            },
        })

        const body = await res.json() as Record<string, unknown>

        logger.info({
            event: 'mcp_tool_call',
            tool_name: 'plexo_pax_revoke',
            token_id: ctx.token_id,
            app_name: input.app_name,
        }, 'plexo_pax_revoke called')

        return body
    } catch (err) {
        const corrId = crypto.randomUUID()
        logger.error({ err, correlation_id: corrId }, 'plexo_pax_revoke failed')
        return internalError(corrId)
    }
}
