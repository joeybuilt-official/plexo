/**
 * Connections & marketplace API
 *
 * GET  /api/connections/registry              All available integrations
 * GET  /api/connections/registry/:id          Single integration detail
 * GET  /api/connections/installed?workspaceId Installed connections for a workspace
 * POST /api/connections/install               Install a connection
 * PATCH /api/connections/installed/:id        Update settings/credentials
 * DELETE /api/connections/installed/:id       Uninstall
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, and } from '@plexo/db'
import { connectionsRegistry, installedConnections } from '@plexo/db'
import { encrypt } from '../crypto.js'
import { logger } from '../logger.js'

export const connectionsRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── GET /api/connections/registry ────────────────────────────────────────────

connectionsRouter.get('/registry', async (_req, res) => {
    try {
        const items = await db.select().from(connectionsRegistry)
        res.json({ items, total: items.length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/registry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load registry' } })
    }
})

// ── GET /api/connections/registry/:id ────────────────────────────────────────

connectionsRouter.get('/registry/:id', async (req, res) => {
    const { id } = req.params
    try {
        const [item] = await db.select().from(connectionsRegistry).where(eq(connectionsRegistry.id, id)).limit(1)
        if (!item) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Connection not found in registry' } })
            return
        }
        res.json(item)
    } catch (err: unknown) {
        logger.error({ err, id }, 'GET /api/connections/registry/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load connection' } })
    }
})

// ── GET /api/connections/installed ───────────────────────────────────────────

connectionsRouter.get('/installed', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const items = await db.select({
            id: installedConnections.id,
            registryId: installedConnections.registryId,
            name: installedConnections.name,
            status: installedConnections.status,
            scopesGranted: installedConnections.scopesGranted,
            lastVerifiedAt: installedConnections.lastVerifiedAt,
            createdAt: installedConnections.createdAt,
        }).from(installedConnections)
            .where(eq(installedConnections.workspaceId, workspaceId))

        res.json({ items, total: items.length })
    } catch (err: unknown) {
        logger.error({ err }, 'GET /api/connections/installed failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load installed connections' } })
    }
})

// ── POST /api/connections/install ─────────────────────────────────────────────

connectionsRouter.post('/install', async (req, res) => {
    const { workspaceId, registryId, credentials = {}, name } = req.body as {
        workspaceId?: string
        registryId?: string
        credentials?: Record<string, string>
        name?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId) || !registryId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and registryId required' } })
        return
    }

    try {
        const [reg] = await db.select({ id: connectionsRegistry.id, name: connectionsRegistry.name, authType: connectionsRegistry.authType })
            .from(connectionsRegistry).where(eq(connectionsRegistry.id, registryId)).limit(1)

        if (!reg) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Integration not found in registry' } })
            return
        }

        // Encrypt credentials at rest with workspace-scoped AES-256-GCM key
        const encryptedCreds = Object.keys(credentials).length > 0
            ? { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
            : {}

        const [installed] = await db.insert(installedConnections).values({
            workspaceId,
            registryId: reg.id,
            name: name ?? reg.name,
            credentials: encryptedCreds,
            status: 'active',
        }).returning({ id: installedConnections.id })

        logger.info({ workspaceId, registryId, name: reg.name }, 'Connection installed')
        res.status(201).json({ id: installed!.id, message: 'Connection installed' })
    } catch (err: unknown) {
        logger.error({ err }, 'POST /api/connections/install failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Install failed' } })
    }
})

// ── PATCH /api/connections/installed/:id ─────────────────────────────────────

connectionsRouter.patch('/installed/:id', async (req, res) => {
    const { id } = req.params
    const { workspaceId, status, credentials } = req.body as {
        workspaceId?: string
        status?: 'active' | 'disconnected'
        credentials?: Record<string, string>
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const update: Record<string, unknown> = {}
        if (status) update.status = status
        if (credentials && Object.keys(credentials).length > 0) {
            update.credentials = { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
        }

        await db.update(installedConnections)
            .set(update)
            .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))

        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'PATCH /api/connections/installed/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── DELETE /api/connections/installed/:id ────────────────────────────────────

connectionsRouter.delete('/installed/:id', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        await db.delete(installedConnections)
            .where(and(eq(installedConnections.id, id), eq(installedConnections.workspaceId, workspaceId)))

        logger.info({ id, workspaceId }, 'Connection uninstalled')
        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'DELETE /api/connections/installed/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Uninstall failed' } })
    }
})
