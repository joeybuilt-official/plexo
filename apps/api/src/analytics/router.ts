// SPDX-License-Identifier: MIT
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
import { eq, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaces, appProfiles } from '@plexo/db'
import { resolveServiceAuth } from '../middleware/service-key-auth.js'
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

// ── Per-app ingest helpers ──────────────────────────────────────────────────
// Resolves the app identity for an inbound /error or /ingest request.
//   - No Bearer token  → app='plexo' (preserves existing anonymous public callers).
//   - Bearer present   → must be PLEXO_SERVICE_KEY AND X-App-Id must match a
//                        registered Pex App Profile (apps/api/src/routes/profiles.ts).
// We validate inline rather than mounting requireServiceKey at the route level
// because the existing /ingest path is *intentionally* public for Plexo's own
// anonymous telemetry; only non-plexo apps need to authenticate.

const APP_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const profileCache = new Map<string, number>()  // appId → expiry ms
const PROFILE_CACHE_TTL_MS = 60_000

async function isRegisteredApp(appId: string): Promise<boolean> {
    const cached = profileCache.get(appId)
    if (cached && cached > Date.now()) return true
    const [row] = await db.select({ appId: appProfiles.appId })
        .from(appProfiles).where(eq(appProfiles.appId, appId)).limit(1)
    if (!row) return false
    profileCache.set(appId, Date.now() + PROFILE_CACHE_TTL_MS)
    return true
}

type AppAuth = { ok: true; appId: string } | { ok: false; status: number; error: string }

async function resolveAppForIngest(req: import('express').Request): Promise<AppAuth> {
    const authHeader = req.headers.authorization
    if (!authHeader) return { ok: true, appId: 'plexo' }

    if (!authHeader.startsWith('Bearer ')) {
        return { ok: false, status: 401, error: 'Malformed Authorization header' }
    }
    const token = authHeader.slice(7)
    const headerAppId = req.headers['x-app-id'] as string | undefined
    // Shared PLEXO_SERVICE_KEY callers must name their app (the key is shared
    // across apps); per-app `psk_` keys self-identify, so the header is optional
    // for them. Checking here keeps the 400 "missing X-App-Id" contract the
    // A3 dual-accept refactor would otherwise collapse into a 401.
    if (!headerAppId && !token.startsWith('psk_')) {
        return { ok: false, status: 400, error: 'Missing or invalid X-App-Id header' }
    }
    // A3 dual-accept: shared PLEXO_SERVICE_KEY OR per-app key
    const resolved = await resolveServiceAuth(token, headerAppId)
    if (!resolved) {
        return { ok: false, status: 401, error: 'Invalid service key' }
    }
    const appId = resolved.appId
    if (!APP_ID_RE.test(appId)) {
        return { ok: false, status: 400, error: 'Missing or invalid X-App-Id header' }
    }
    if (appId === 'plexo') return { ok: true, appId }  // first-party shortcut
    if (!(await isRegisteredApp(appId))) {
        return { ok: false, status: 403, error: `App profile not registered: ${appId}` }
    }
    return { ok: true, appId }
}

// POST /api/v1/analytics/ingest — telemetry event (plexo or registered app)
analyticsRouter.post('/ingest', async (req, res) => {
    if (process.env.PLEXO_ANALYTICS_ENABLED === 'false') {
        res.status(204).end()
        return
    }

    const auth = await resolveAppForIngest(req)
    if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error })
        return
    }

    const { event_name, properties = {}, instance_uuid } = req.body as {
        event_name?: string
        properties?: Record<string, unknown>
        instance_uuid?: string
    }

    if (!event_name || typeof event_name !== 'string') {
        res.status(400).json({ error: 'event_name required' })
        return
    }

    // Per-app event-name namespacing:
    //   app='plexo' → must be in ALLOWED_EVENT_NAMES; properties allowlisted.
    //   app=<other> → event_name MUST start with `<appId>.` (prevents apps from
    //                 forging plexo_* events); properties pass through (apps
    //                 own their own schema per ADR-04 amendment).
    let storedProps: Record<string, unknown>
    if (auth.appId === 'plexo') {
        if (!ALLOWED_EVENT_NAMES.has(event_name)) {
            res.status(400).json({ error: 'Invalid or disallowed event_name' })
            return
        }
        storedProps = sanitizeProperties(properties)
    } else {
        if (!event_name.startsWith(`${auth.appId}.`)) {
            res.status(400).json({ error: `event_name must be namespaced as '${auth.appId}.<name>'` })
            return
        }
        storedProps = properties && typeof properties === 'object' ? properties : {}
    }

    try {
        await db.execute(sql`
            INSERT INTO plexo_ops_analytics (app, event_name, properties, instance_uuid)
            VALUES (${auth.appId}, ${event_name}, ${JSON.stringify(storedProps)}::jsonb, ${instance_uuid ?? null})
        `)
        res.status(201).json({ ok: true })
    } catch (err) {
        logger.error({ err, app: auth.appId }, 'analytics ingest failed')
        res.status(500).json({ error: 'Ingest failed' })
    }
})

// POST /api/v1/analytics/error — structured error capture (plexo or registered app)
analyticsRouter.post('/error', async (req, res) => {
    const auth = await resolveAppForIngest(req)
    if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error })
        return
    }

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

    // The unique index on plexo_ops_errors.fingerprint (migration 0048) is global,
    // so we namespace non-plexo fingerprints to prevent cross-app upsert collisions.
    // 'plexo' callers keep their existing fingerprint shape (backward compatible).
    const storedFingerprint = auth.appId === 'plexo' ? fingerprint : `${auth.appId}:${fingerprint}`

    try {
        await db.execute(sql`
            INSERT INTO plexo_ops_errors (app, fingerprint, message, stack_trace, context, deploy_id)
            VALUES (${auth.appId}, ${storedFingerprint}, ${message}, ${stack_trace ?? null}, ${JSON.stringify(context ?? {})}::jsonb, ${deploy_id ?? null})
            ON CONFLICT (fingerprint) DO UPDATE SET
                last_seen_at = NOW(),
                occurrence_count = plexo_ops_errors.occurrence_count + 1,
                stack_trace = COALESCE(EXCLUDED.stack_trace, plexo_ops_errors.stack_trace),
                context = COALESCE(EXCLUDED.context, plexo_ops_errors.context)
        `)
        res.status(201).json({ ok: true })
    } catch (err) {
        logger.error({ err, app: auth.appId }, 'error ingest failed')
        res.status(500).json({ error: 'Ingest failed' })
    }
})
