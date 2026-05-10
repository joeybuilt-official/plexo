// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /api/v1/channel/dispatch — HTTP wrapper around channel-dispatch.ts
 *
 * Exposes the in-process `dispatchChannel()` handler (Stream B) over HTTP so
 * external Joeybuilt apps (e.g., Levio) that cannot import the SDK directly
 * can dispatch messages on behalf of a Plexo user.
 *
 * Auth (mirrors apps/api/src/analytics/router.ts:resolveAppForIngest, but
 * without the `appId='plexo'` anonymous shortcut — channel dispatch always
 * requires a registered app):
 *
 *   Authorization: Bearer <PLEXO_SERVICE_KEY>     (required)
 *   X-App-Id:      <registered app slug>           (required, in app_profiles)
 *
 * Required dispatch headers (forwarded into DispatchContext):
 *   X-Tenant-Id, X-Workspace-Id, X-User-Id, X-Trace-Id
 *
 * Body: { channel, recipientUserId, message: { text, attachments?, metadata? },
 *         idempotencyKey, scopeOverrides? }
 *
 * Status codes:
 *   200 — { messageId?, deliveryStatus }   (incl. deliveryStatus='not_implemented')
 *   400 — DispatchValidationError or missing/invalid required headers
 *   401 — Bearer missing/malformed/invalid
 *   403 — Bearer valid but X-App-Id not registered
 *   500 — unhandled internal error
 */

import { Router, type Router as RouterType, type Request } from 'express'
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto'
import { db, eq } from '@plexo/db'
import { appProfiles } from '@plexo/db'
import pino from 'pino'
import {
    dispatchChannel,
    DispatchValidationError,
    type DispatchContext,
    type DispatchParams,
} from '../channel-dispatch.js'

const logger = pino({ name: 'channel-dispatch-route' })
export const channelDispatchRouter: RouterType = Router()

const APP_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const profileCache = new Map<string, number>()
const PROFILE_CACHE_TTL_MS = 60_000

function timingSafeStrEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return cryptoTimingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'))
}

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

async function resolveAppForDispatch(req: Request): Promise<AppAuth> {
    const authHeader = req.headers.authorization
    if (!authHeader) {
        return { ok: false, status: 401, error: 'Missing Authorization header' }
    }
    if (!authHeader.startsWith('Bearer ')) {
        return { ok: false, status: 401, error: 'Malformed Authorization header' }
    }
    const token = authHeader.slice(7)
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!serviceKey || !timingSafeStrEqual(token, serviceKey)) {
        return { ok: false, status: 401, error: 'Invalid service key' }
    }

    const appId = req.headers['x-app-id'] as string | undefined
    if (!appId) {
        return { ok: false, status: 401, error: 'Missing X-App-Id header' }
    }
    if (!APP_ID_RE.test(appId)) {
        return { ok: false, status: 400, error: 'Invalid X-App-Id header' }
    }
    if (!(await isRegisteredApp(appId))) {
        return { ok: false, status: 403, error: `App profile not registered: ${appId}` }
    }
    return { ok: true, appId }
}

function readRequiredHeader(req: Request, name: string): string | null {
    const v = req.headers[name.toLowerCase()]
    if (typeof v !== 'string' || v.length === 0) return null
    return v
}

// Test-only escape hatch — DO NOT call from production paths.
export function _resetDispatchRouteCachesForTests(): void {
    profileCache.clear()
}

// POST /api/v1/channel/dispatch
channelDispatchRouter.post('/dispatch', async (req, res) => {
    const auth = await resolveAppForDispatch(req)
    if (!auth.ok) {
        res.status(auth.status).json({ error: auth.error })
        return
    }

    const tenantId = readRequiredHeader(req, 'X-Tenant-Id')
    const workspaceId = readRequiredHeader(req, 'X-Workspace-Id')
    const userId = readRequiredHeader(req, 'X-User-Id')
    const traceId = readRequiredHeader(req, 'X-Trace-Id')

    if (!tenantId || !workspaceId || !userId || !traceId) {
        res.status(400).json({
            error: 'invalid_argument',
            message: 'Missing required header(s): X-Tenant-Id, X-Workspace-Id, X-User-Id, X-Trace-Id',
        })
        return
    }

    const body = (req.body ?? {}) as Partial<DispatchParams>
    const params: DispatchParams = {
        channel: body.channel as string,
        recipientUserId: body.recipientUserId as string,
        message: body.message as DispatchParams['message'],
        idempotencyKey: body.idempotencyKey as string,
        scopeOverrides: body.scopeOverrides,
    }

    const ctx: DispatchContext = { tenantId, workspaceId, userId, traceId }

    try {
        const result = await dispatchChannel(params, ctx)
        res.status(200).json(result)
    } catch (err) {
        if (err instanceof DispatchValidationError) {
            res.status(400).json({ error: 'invalid_argument', message: err.message })
            return
        }
        logger.error({
            err,
            appId: auth.appId,
            tenantId,
            workspaceId,
            traceId,
        }, 'channel.dispatch route — unhandled error')
        res.status(500).json({ error: 'internal_error' })
    }
})
