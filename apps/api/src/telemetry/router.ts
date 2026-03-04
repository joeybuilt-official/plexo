/**
 * Telemetry API routes
 *
 * GET  /api/v1/telemetry          — current config (enabled, instanceId)
 * POST /api/v1/telemetry          — update enabled + instanceId
 * GET  /api/v1/telemetry/payload  — last sanitized payload from Redis
 */
import { Router, type Router as RouterType } from 'express'
import { randomUUID } from 'node:crypto'
import {
    getTelemetryConfig,
    setTelemetryEnabled,
    configureTelemetry,
    getLastPayload,
} from './posthog.js'
import { db, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import pino from 'pino'

const logger = pino({ name: 'telemetry-router' })
export const telemetryRouter: RouterType = Router()

// GET /api/v1/telemetry
telemetryRouter.get('/', (_req, res) => {
    res.json(getTelemetryConfig())
})

// POST /api/v1/telemetry — { enabled: boolean }
telemetryRouter.post('/', async (req, res) => {
    const { enabled } = req.body as { enabled?: boolean }

    if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'enabled must be boolean' } })
        return
    }

    setTelemetryEnabled(enabled)

    // Persist to workspace settings — use x-workspace-id header
    const workspaceId = req.headers['x-workspace-id'] as string | undefined
    if (workspaceId) {
        try {
            const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
                .where(eq(workspaces.id, workspaceId)).limit(1)
            if (ws) {
                const settings = (ws.settings ?? {}) as Record<string, unknown>
                settings.telemetry = { ...(settings.telemetry as Record<string, unknown> ?? {}), enabled }
                await db.update(workspaces).set({ settings }).where(eq(workspaces.id, workspaceId))
            }
        } catch (err) {
            logger.warn({ err }, 'Failed to persist telemetry setting')
        }
    }

    logger.info({ enabled }, 'Telemetry setting updated')
    res.json({ ok: true, enabled })
})

// POST /api/v1/telemetry/regenerate-id — generate a new anonymous instance ID
telemetryRouter.post('/regenerate-id', async (req, res) => {
    const newId = randomUUID()
    const { instanceId: _old, enabled } = getTelemetryConfig()

    configureTelemetry({
        enabled,
        instanceId: newId,
        plexoVersion: process.env.npm_package_version ?? '0.1.0',
        redisUrl: process.env.REDIS_URL,
    })

    // Persist to workspace settings
    const workspaceId = req.headers['x-workspace-id'] as string | undefined
    if (workspaceId) {
        try {
            const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
                .where(eq(workspaces.id, workspaceId)).limit(1)
            if (ws) {
                const settings = (ws.settings ?? {}) as Record<string, unknown>
                settings.telemetry = { ...(settings.telemetry as Record<string, unknown> ?? {}), instanceId: newId }
                await db.update(workspaces).set({ settings }).where(eq(workspaces.id, workspaceId))
            }
        } catch (err) {
            logger.warn({ err }, 'Failed to persist new instance ID')
        }
    }

    logger.info({ newId }, 'Telemetry instance ID regenerated')
    res.json({ ok: true, instanceId: newId })
})

// GET /api/v1/telemetry/payload — last sanitized crash payload
telemetryRouter.get('/payload', async (_req, res) => {
    const payload = await getLastPayload()
    res.json({ payload })
})
