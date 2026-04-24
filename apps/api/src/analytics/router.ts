// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Analytics API routes
 *
 * GET  /api/v1/analytics          — current config (errorsEnabled, usageEnabled, instanceId)
 * POST /api/v1/analytics          — update consent; persists to workspace.settings
 * POST /api/v1/analytics/regenerate-id — new anonymous instance ID
 * GET  /api/v1/analytics/payload  — last sanitized error payload from Redis
 */
import { Router, type Router as RouterType } from 'express'
import { randomUUID } from 'node:crypto'
import {
    isErrorsEnabled,
    isUsageEnabled,
    setErrorsEnabled,
    setUsageEnabled,
    configureAnalytics,
    getLastPayload,
    getAnalyticsConfig,
} from './config.js'
import { db, eq, sql } from '@plexo/db'
import { workspaces } from '@plexo/db'
import pino from 'pino'

const logger = pino({ name: 'analytics-router' })
export const analyticsRouter: RouterType = Router()

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnalyticsSettings {
    // Split fields (v2)
    errors_enabled?: boolean
    usage_enabled?: boolean
    // Legacy single toggle (v1 backwards compat)
    enabled?: boolean
    instance_id?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loadFromDb(workspaceId: string): Promise<AnalyticsSettings | null> {
    try {
        const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) return null
        const settings = (ws.settings ?? {}) as Record<string, unknown>
        return (settings.analytics ?? settings.telemetry ?? {}) as AnalyticsSettings
    } catch (err) {
        logger.warn({ err }, 'Failed to load analytics settings from DB')
        return null
    }
}

async function saveToDb(workspaceId: string, patch: AnalyticsSettings): Promise<void> {
    try {
        const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) return
        const settings = (ws.settings ?? {}) as Record<string, unknown>
        settings.analytics = { ...(settings.analytics as AnalyticsSettings ?? {}), ...patch }
        await db.update(workspaces).set({ settings }).where(eq(workspaces.id, workspaceId))
    } catch (err) {
        logger.warn({ err }, 'Failed to persist analytics setting')
    }
}

function resolveFromSettings(s: AnalyticsSettings): { errorsEnabled: boolean; usageEnabled: boolean } {
    const errorsEnabled = typeof s.errors_enabled === 'boolean' ? s.errors_enabled
        : typeof s.enabled === 'boolean' ? s.enabled : false
    const usageEnabled = typeof s.usage_enabled === 'boolean' ? s.usage_enabled
        : typeof s.enabled === 'boolean' ? s.enabled : false
    return { errorsEnabled, usageEnabled }
}

// ── GET /api/v1/analytics ─────────────────────────────────────────────────────

analyticsRouter.get('/', async (req, res) => {
    const workspaceId = req.headers['x-workspace-id'] as string | undefined

    if (workspaceId) {
        const persisted = await loadFromDb(workspaceId)
        if (persisted) {
            const { errorsEnabled, usageEnabled } = resolveFromSettings(persisted)
            const { instanceId } = getAnalyticsConfig()
            const resolvedId = persisted.instance_id ?? instanceId

            // Sync in-memory
            setErrorsEnabled(errorsEnabled)
            setUsageEnabled(usageEnabled)

            res.json({ errorsEnabled, usageEnabled, instanceId: resolvedId })
            return
        }
    }

    // Fallback to in-memory (no workspace context)
    res.json({
        errorsEnabled: isErrorsEnabled(),
        usageEnabled: isUsageEnabled(),
        instanceId: getAnalyticsConfig().instanceId,
    })
})

// ── POST /api/v1/analytics ────────────────────────────────────────────────────

analyticsRouter.post('/', async (req, res) => {
    const body = req.body as {
        errorsEnabled?: boolean
        usageEnabled?: boolean
        enabled?: boolean      // legacy single toggle
    }

    const hasErrors = typeof body.errorsEnabled === 'boolean'
    const hasUsage = typeof body.usageEnabled === 'boolean'
    const hasLegacy = typeof body.enabled === 'boolean'

    if (!hasErrors && !hasUsage && !hasLegacy) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'errorsEnabled or usageEnabled required' } })
        return
    }

    const patch: AnalyticsSettings = {}

    if (hasErrors) {
        patch.errors_enabled = body.errorsEnabled
        setErrorsEnabled(body.errorsEnabled!)
    }
    if (hasUsage) {
        patch.usage_enabled = body.usageEnabled
        setUsageEnabled(body.usageEnabled!)
    }
    if (hasLegacy && !hasErrors && !hasUsage) {
        // Legacy: both channels mirror the single toggle
        patch.errors_enabled = body.enabled
        patch.usage_enabled = body.enabled
        setErrorsEnabled(body.enabled!)
        setUsageEnabled(body.enabled!)
    }

    const workspaceId = req.headers['x-workspace-id'] as string | undefined
    if (workspaceId) {
        await saveToDb(workspaceId, patch)
    }

    logger.info({ patch, workspaceId }, 'Analytics consent updated')
    res.json({ ok: true, errorsEnabled: isErrorsEnabled(), usageEnabled: isUsageEnabled() })
})

// ── POST /api/v1/analytics/regenerate-id ──────────────────────────────────────

analyticsRouter.post('/regenerate-id', async (req, res) => {
    const newId = randomUUID()

    configureAnalytics({
        errorsEnabled: isErrorsEnabled(),
        usageEnabled: isUsageEnabled(),
        instanceId: newId,
        plexoVersion: process.env.npm_package_version ?? '0.1.0',
        redisUrl: process.env.REDIS_URL,
    })

    const workspaceId = req.headers['x-workspace-id'] as string | undefined
    if (workspaceId) {
        await saveToDb(workspaceId, { instance_id: newId })
    }

    logger.info({ newId }, 'Analytics instance ID regenerated')
    res.json({ ok: true, instanceId: newId })
})

// ── GET /api/v1/analytics/payload ─────────────────────────────────────────────

analyticsRouter.get('/payload', async (_req, res) => {
    const payload = await getLastPayload()
    res.json({ payload })
})

// ── Plexo-native ingest ─────────────────────────────────────────────────────
// Writes to plexo_ops_errors and plexo_ops_analytics tables.
// Hard property allowlist enforced — no user content, no file paths.

const ALLOWED_EVENT_NAMES = new Set([
    'plexo_installed',
    'plexo_agent_run',
    'plexo_skill_installed',
    'plexo_skill_run',
    'plexo_mcp_connected',
    'plexo_task_completed',
    'plexo_task_failed',
    'plexo_extension_installed',
    'plexo_inference_gateway_call',
    'plexo_onboarding_completed',
])

const ALLOWED_PROPERTIES = new Set([
    'instance_uuid', 'model', 'provider', 'duration_ms', 'success',
    'skill_name', 'extension_name', 'task_type', 'error_code',
    'latency_ms', 'source',
])

function sanitizeProperties(props: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
        if (ALLOWED_PROPERTIES.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
            clean[k] = v
        }
    }
    return clean
}

// POST /api/v1/analytics/ingest — anonymous analytics event
analyticsRouter.post('/ingest', async (req, res) => {
    if (process.env.PLEXO_ANALYTICS_ENABLED === 'false') {
        res.status(204).end()
        return
    }

    const { event_name, properties = {}, instance_uuid } = req.body as {
        event_name?: string
        properties?: Record<string, unknown>
        instance_uuid?: string
    }

    if (!event_name || !ALLOWED_EVENT_NAMES.has(event_name)) {
        res.status(400).json({ error: 'Invalid or disallowed event_name' })
        return
    }

    const sanitized = sanitizeProperties(properties)

    try {
        await db.execute(sql`
            INSERT INTO plexo_ops_analytics (app, event_name, properties, instance_uuid)
            VALUES ('plexo', ${event_name}, ${JSON.stringify(sanitized)}::jsonb, ${instance_uuid ?? null})
        `)
        res.status(201).json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'analytics ingest failed')
        res.status(500).json({ error: 'Ingest failed' })
    }
})

// POST /api/v1/analytics/error — structured error capture
analyticsRouter.post('/error', async (req, res) => {
    const { fingerprint, message, stack_trace, context, deploy_id } = req.body as {
        fingerprint?: string
        message?: string
        stack_trace?: string
        context?: Record<string, unknown>
        deploy_id?: string
    }

    if (!fingerprint || !message) {
        res.status(400).json({ error: 'fingerprint and message required' })
        return
    }

    try {
        // Upsert: increment count if same fingerprint, else insert
        await db.execute(sql`
            INSERT INTO plexo_ops_errors (app, fingerprint, message, stack_trace, context, deploy_id)
            VALUES ('plexo', ${fingerprint}, ${message}, ${stack_trace ?? null}, ${JSON.stringify(context ?? {})}::jsonb, ${deploy_id ?? null})
            ON CONFLICT (fingerprint) DO UPDATE SET
                last_seen_at = NOW(),
                occurrence_count = plexo_ops_errors.occurrence_count + 1,
                stack_trace = COALESCE(EXCLUDED.stack_trace, plexo_ops_errors.stack_trace),
                context = COALESCE(EXCLUDED.context, plexo_ops_errors.context)
        `)
        res.status(201).json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'error ingest failed')
        res.status(500).json({ error: 'Ingest failed' })
    }
})
