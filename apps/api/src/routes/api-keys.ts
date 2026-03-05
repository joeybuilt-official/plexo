import { Router, type Router as RouterType } from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { db, eq, and, desc } from '@plexo/db'
import { mcpTokens } from '@plexo/db'
import { logger } from '../logger.js'

export const apiKeysRouter: RouterType = Router({ mergeParams: true })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CreateKeySchema = z.object({
    name: z.string().min(1).max(100),
    scopes: z.array(z.string()).optional().default([]),
})

// GET /api/v1/workspaces/:workspaceId/api-keys
apiKeysRouter.get('/', async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }

    try {
        const rows = await db
            .select({
                id: mcpTokens.id,
                name: mcpTokens.name,
                scopes: mcpTokens.scopes,
                type: mcpTokens.type,
                createdAt: mcpTokens.createdAt,
                lastUsedAt: mcpTokens.lastUsedAt,
            })
            .from(mcpTokens)
            .where(
                and(
                    eq(mcpTokens.workspaceId, workspaceId),
                    eq(mcpTokens.revoked, false)
                )
            )
            .orderBy(desc(mcpTokens.createdAt))

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'Failed to list API keys')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list API keys' } })
    }
})

// POST /api/v1/workspaces/:workspaceId/api-keys
apiKeysRouter.post('/', async (req, res) => {
    const { workspaceId } = req.params as { workspaceId: string }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }

    const parse = CreateKeySchema.safeParse(req.body)
    if (!parse.success) {
        res.status(400).json({
            error: { code: 'VALIDATION_ERROR', issues: parse.error.issues },
        })
        return
    }

    try {
        // Generate secure token and salt
        const rawToken = crypto.randomBytes(32).toString('hex')
        const tokenPrefix = 'plx_'
        const fullToken = `${tokenPrefix}${rawToken}`

        const salt = crypto.randomBytes(16).toString('hex')
        const hash = crypto.createHash('sha256').update(fullToken + salt).digest('hex')

        const [created] = await db.insert(mcpTokens).values({
            workspaceId,
            name: parse.data.name,
            tokenHash: hash,
            tokenSalt: salt,
            scopes: parse.data.scopes,
            type: 'mcp'
        }).returning({
            id: mcpTokens.id,
            name: mcpTokens.name,
            createdAt: mcpTokens.createdAt,
        })

        logger.info({ workspaceId, keyId: created!.id }, 'Created new API key')

        res.status(201).json({
            id: created!.id,
            name: created!.name,
            createdAt: created!.createdAt,
            token: fullToken, // Only returned once!
        })
    } catch (err) {
        logger.error({ err }, 'Failed to create API key')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create API key' } })
    }
})

// DELETE /api/v1/workspaces/:workspaceId/api-keys/:keyId
apiKeysRouter.delete('/:keyId', async (req, res) => {
    const { workspaceId, keyId } = req.params as { workspaceId: string; keyId: string }

    if (!workspaceId || !UUID_RE.test(workspaceId) || !UUID_RE.test(keyId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }

    try {
        await db.update(mcpTokens)
            .set({ revoked: true })
            .where(
                and(
                    eq(mcpTokens.id, keyId),
                    eq(mcpTokens.workspaceId, workspaceId)
                )
            )

        logger.info({ workspaceId, keyId }, 'Revoked API key')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'Failed to revoke API key')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke API key' } })
    }
})
