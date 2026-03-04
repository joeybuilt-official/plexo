/**
 * Plugins API
 *
 * GET    /api/plugins?workspaceId=   List installed plugins
 * GET    /api/plugins/:id            Get plugin by ID
 * POST   /api/plugins                Install a plugin (from manifest JSON)
 * PATCH  /api/plugins/:id            Update enabled state or settings
 * DELETE /api/plugins/:id            Uninstall plugin
 *
 * The agent executor calls loadPluginTools(workspaceId) to get
 * tool definitions from all enabled plugins at task start.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, and } from '@plexo/db'
import { plugins, workspaces } from '@plexo/db'
import { logger } from '../logger.js'
import { audit } from '../audit.js'

export const pluginsRouter: RouterType = Router()

type PluginType = 'skill' | 'channel' | 'tool' | 'card' | 'mcp-server' | 'theme'
const VALID_TYPES: PluginType[] = ['skill', 'channel', 'tool', 'card', 'mcp-server', 'theme']

// ── GET /api/plugins ──────────────────────────────────────────────────────────

pluginsRouter.get('/', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }

    try {
        const rows = await db
            .select()
            .from(plugins)
            .where(eq(plugins.workspaceId, workspaceId))
            .orderBy(plugins.installedAt)

        res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/plugins failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list plugins' } })
    }
})

// ── GET /api/plugins/:id ──────────────────────────────────────────────────────

pluginsRouter.get('/:id', async (req, res) => {
    try {
        const [plugin] = await db.select().from(plugins).where(eq(plugins.id, req.params.id)).limit(1)
        if (!plugin) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plugin not found' } })
            return
        }
        res.json(plugin)
    } catch (err) {
        logger.error({ err }, 'GET /api/plugins/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get plugin' } })
    }
})

// ── POST /api/plugins ─────────────────────────────────────────────────────────

pluginsRouter.post('/', async (req, res) => {
    const { workspaceId, manifest, settings = {} } = req.body as {
        workspaceId?: string
        manifest?: { name?: string; version?: string; type?: string;[k: string]: unknown }
        settings?: Record<string, unknown>
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!manifest?.name || !manifest.version || !manifest.type) {
        res.status(400).json({ error: { code: 'INVALID_MANIFEST', message: 'manifest must include name, version, type' } })
        return
    }
    if (!VALID_TYPES.includes(manifest.type as PluginType)) {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: `type must be one of: ${VALID_TYPES.join(', ')}` } })
        return
    }

    try {
        // Validate workspace exists
        const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const [inserted] = await db.insert(plugins).values({
            workspaceId,
            name: manifest.name,
            version: manifest.version,
            type: manifest.type as PluginType,
            manifest: manifest as object,
            enabled: false,
            settings,
        }).returning()

        if (!inserted) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Insert returned no data' } })
            return
        }

        logger.info({ id: inserted.id, name: manifest.name }, 'Plugin installed')
        audit(req, { workspaceId, action: 'plugin.install', resource: 'plugins', resourceId: inserted.id, metadata: { name: manifest.name, version: manifest.version, type: manifest.type } })
        res.status(201).json(inserted)
    } catch (err) {
        logger.error({ err }, 'POST /api/plugins failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to install plugin' } })
    }
})

// ── PATCH /api/plugins/:id ────────────────────────────────────────────────────

pluginsRouter.patch('/:id', async (req, res) => {
    const { enabled, settings } = req.body as { enabled?: boolean; settings?: Record<string, unknown> }

    try {
        const [existing] = await db.select().from(plugins).where(eq(plugins.id, req.params.id)).limit(1)
        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plugin not found' } })
            return
        }

        const update: Record<string, unknown> = {}
        if (typeof enabled === 'boolean') update.enabled = enabled
        if (settings) update.settings = { ...(existing.settings as object), ...settings }

        if (Object.keys(update).length === 0) {
            res.status(400).json({ error: { code: 'NOTHING_TO_UPDATE', message: 'Provide enabled or settings' } })
            return
        }

        await db.update(plugins).set(update).where(eq(plugins.id, req.params.id))
        logger.info({ id: req.params.id, update }, 'Plugin updated')
        if (typeof enabled === 'boolean') {
            audit(req, { workspaceId: existing.workspaceId, action: enabled ? 'plugin.enable' : 'plugin.disable', resource: 'plugins', resourceId: req.params.id, metadata: { name: existing.name } })
        }
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'PATCH /api/plugins/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── DELETE /api/plugins/:id ───────────────────────────────────────────────────

pluginsRouter.delete('/:id', async (req, res) => {
    try {
        const [existing] = await db.select({ id: plugins.id, workspaceId: plugins.workspaceId, name: plugins.name }).from(plugins).where(eq(plugins.id, req.params.id)).limit(1)
        if (!existing) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Plugin not found' } })
            return
        }

        await db.delete(plugins).where(eq(plugins.id, req.params.id))
        logger.info({ id: req.params.id }, 'Plugin uninstalled')
        audit(req, { workspaceId: existing.workspaceId, action: 'plugin.uninstall', resource: 'plugins', resourceId: req.params.id, metadata: { name: existing.name } })
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE /api/plugins/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Uninstall failed' } })
    }
})
