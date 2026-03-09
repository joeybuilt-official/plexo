// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Telemetry API routes
 *
 * GET  /api/v1/telemetry          — current config (enabled, instanceId) — reads from DB
 * POST /api/v1/telemetry          — update enabled; persists to workspace.settings
 * POST /api/v1/telemetry/regenerate-id — new anonymous instance ID
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

// ── Helpers ───────────────────────────────────────────────────────────────────

interface TelemetrySettings {
    enabled?: boolean
    instanceId?: string
}

async function loadFromDb(workspaceId: string): Promise<TelemetrySettings | null> {
    try {
        const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) return null
        const settings = (ws.settings ?? {}) as Record<string, unknown>
        return (settings.telemetry ?? {}) as TelemetrySettings
    } catch (err) {
        logger.warn({ err }, 'Failed to load telemetry settings from DB')
        return null
    }
}

async function saveToDb(workspaceId: string, patch: TelemetrySettings): Promise<void> {
    try {
        const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) return
        const settings = (ws.settings ?? {}) as Record<string, unknown>
        settings.telemetry = { ...(settings.telemetry as TelemetrySettings ?? {}), ...patch }
        await db.update(workspaces).set({ settings }).where(eq(workspaces.id, workspaceId))
    } catch (err) {
        logger.warn({ err }, 'Failed to persist telemetry setting')
    }
}

// ── GET /api/v1/telemetry ─────────────────────────────────────────────────────

telemetryRouter.get('/', async (req, res) => {
    const workspaceId = req.headers['x-workspace-id'] as string | undefined

    // Always prefer DB value — in-memory is unreliable across restarts
    if (workspaceId) {
        const persisted = await loadFromDb(workspaceId)
        if (persisted) {
            const enabled = persisted.enabled ?? false
            const { instanceId } = getTelemetryConfig()
            const resolvedId = persisted.instanceId ?? instanceId

            // Sync in-memory so subsequent captures use the right values
            setTelemetryEnabled(enabled)

            res.json({ enabled, instanceId: resolvedId })
            return
        }
    }

    // Fallback to in-memory (CI/CLI or no workspace context)
    res.json(getTelemetryConfig())
})

// ── POST /api/v1/telemetry ────────────────────────────────────────────────────

telemetryRouter.post('/', async (req, res) => {
    const { enabled } = req.body as { enabled?: boolean }

    if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'enabled must be boolean' } })
        return
    }

    // Update in-memory immediately
    setTelemetryEnabled(enabled)

    const workspaceId = req.headers['x-workspace-id'] as string | undefined
    if (workspaceId) {
        await saveToDb(workspaceId, { enabled })
    }

    logger.info({ enabled, workspaceId }, 'Telemetry setting updated')
    res.json({ ok: true, enabled })
})

// ── POST /api/v1/telemetry/regenerate-id ──────────────────────────────────────

telemetryRouter.post('/regenerate-id', async (req, res) => {
    const newId = randomUUID()
    const { enabled } = getTelemetryConfig()

    configureTelemetry({
        enabled,
        instanceId: newId,
        plexoVersion: process.env.npm_package_version ?? '0.1.0',
        redisUrl: process.env.REDIS_URL,
    })

    const workspaceId = req.headers['x-workspace-id'] as string | undefined
    if (workspaceId) {
        await saveToDb(workspaceId, { instanceId: newId })
    }

    logger.info({ newId }, 'Telemetry instance ID regenerated')
    res.json({ ok: true, instanceId: newId })
})

// ── GET /api/v1/telemetry/payload ─────────────────────────────────────────────

telemetryRouter.get('/payload', async (_req, res) => {
    const payload = await getLastPayload()
    res.json({ payload })
})
