// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension Prompt Library API (PEX §7.6).
 *
 * GET    /api/v1/prompts/:workspaceId              → list extension prompts
 * PATCH  /api/v1/prompts/:workspaceId/:promptId    → enable/disable, set variable defaults
 * POST   /api/v1/prompts/:workspaceId/:promptId/resolve → resolve variables, return final text
 */

import { Router, type IRouter } from 'express'
import type { Request, Response } from 'express'
import * as promptsRepo from '../repositories/prompts.repository.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const promptsRouter: IRouter = Router({ mergeParams: true })

function badId(res: Response, param = 'workspaceId') {
    res.status(400).json({ error: { code: 'INVALID_ID', message: `${param} must be a valid UUID` } })
}

// ── GET / — list extension prompts (paginated) ───────────────────────────────

promptsRouter.get('/', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)

    const enabled = req.query['enabled'] as string | undefined
    const extensionName = req.query['extensionName'] as string | undefined
    const tag = req.query['tag'] as string | undefined
    const limit = Math.min(Number(req.query['limit'] ?? 50), 100)
    const offset = Number(req.query['offset'] ?? 0)

    try {
        let rows = await promptsRepo.listPrompts({ workspaceId, enabled, extensionName, limit, offset })

        // Tag filtering in-app since Drizzle array contains is verbose
        if (tag) {
            rows = rows.filter((r) => (r.tags as string[]).includes(tag))
        }

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /prompts failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list prompts' } })
    }
})

// ── PATCH /:promptId — enable/disable, configure variable defaults ───────────

promptsRouter.patch('/:promptId', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    const promptId = req.params['promptId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    if (!UUID_RE.test(promptId)) return void badId(res, 'promptId')

    const { enabled, variableDefaults } = req.body as {
        enabled?: boolean
        variableDefaults?: Record<string, unknown>
    }

    try {
        const existing = await promptsRepo.getPrompt(workspaceId, promptId)

        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Prompt not found' } })
            return
        }

        const update: Record<string, unknown> = { updatedAt: new Date() }
        if (typeof enabled === 'boolean') update.enabled = enabled
        if (variableDefaults) update.variableDefaults = variableDefaults

        await promptsRepo.updatePrompt(promptId, update)

        logger.info({ promptId, enabled, workspaceId }, 'Tool prompt updated')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'PATCH /prompts/:promptId failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── POST /:promptId/resolve — resolve variables and return final text ────────

promptsRouter.post('/:promptId/resolve', async (req: Request, res: Response) => {
    const workspaceId = req.params['workspaceId'] as string
    const promptId = req.params['promptId'] as string
    if (!UUID_RE.test(workspaceId)) return void badId(res)
    if (!UUID_RE.test(promptId)) return void badId(res, 'promptId')

    const { variables = {} } = req.body as { variables?: Record<string, unknown> }

    try {
        const prompt = await promptsRepo.getPrompt(workspaceId, promptId)

        if (!prompt) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Prompt not found' } })
            return
        }

        // Merge: explicit variables > user defaults > schema defaults
        const defaults = (prompt.variableDefaults ?? {}) as Record<string, unknown>
        const schema = (prompt.variables ?? []) as Array<{ name: string; default?: unknown; required?: boolean }>
        const merged: Record<string, string> = {}

        for (const v of schema) {
            const value = variables[v.name] ?? defaults[v.name] ?? v.default ?? ''
            merged[v.name] = String(value)
        }
        // Also include any variables passed that aren't in schema (forward-compat)
        for (const [k, v] of Object.entries(variables)) {
            if (!(k in merged)) merged[k] = String(v)
        }

        // Interpolate {{variable}} placeholders
        let resolved = prompt.template
        for (const [k, v] of Object.entries(merged)) {
            resolved = resolved.replaceAll(`{{${k}}}`, v)
        }

        // Check for unresolved required variables
        const unresolvedMatch = resolved.match(/\{\{([^}]+)\}\}/g)
        const unresolved = unresolvedMatch?.map((m) => m.slice(2, -2)) ?? []

        res.json({ resolved, unresolved, promptId: prompt.id, extensionName: prompt.extensionName })
    } catch (err) {
        logger.error({ err }, 'POST /prompts/:promptId/resolve failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Resolution failed' } })
    }
})
