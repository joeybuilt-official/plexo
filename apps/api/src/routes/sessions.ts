// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — HTTP adapter (Phase 1b).
 *
 * Thin Express Router: validates with the Zod contract from
 * `@plexo/session-fabric`, calls the pure use-cases, and maps their typed
 * `FabricError`s onto HTTP status. All lease/seq/state logic lives in the
 * use-cases; persistence in the Drizzle adapter wired at module load. SSE reuses
 * the repo's existing `text/event-stream` polling pattern (see task-stream.ts).
 */

import { Router, type Router as ExpressRouter } from 'express'
import { ulid } from 'ulid'
import {
    actorType as actorTypeSchema,
    participantKind as participantKindSchema,
    participantRole as participantRoleSchema,
    participantSurface as participantSurfaceSchema,
    policyTier as policyTierSchema,
    runnerBackend as runnerBackendSchema,
    runnerStatus as runnerStatusSchema,
    sessionEventKind as sessionEventKindSchema,
    appendEvent,
    claimLease,
    createSession,
    getSession,
    joinParticipant,
    listMasterSessions,
    registerRunner,
    releaseLease,
    renewLease,
    replayEvents,
    type Deps,
    type FabricErrorCode,
    type Result,
} from '@plexo/session-fabric'
import { z } from 'zod'
import { makeSessionFabricRepo } from '../repositories/session-fabric.repository.js'
import {
    enforceDriveTier,
    enforceEventTier,
    enforceJoinTier,
    killSwitchGuard,
    requireDeviceToken,
} from './fabric-security.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { UUID_RE } from '../validation.js'
import { logger } from '../logger.js'

export const sessionFabricRouter: ExpressRouter = Router()

const deps: Deps = {
    repo: makeSessionFabricRepo(),
    clock: { now: () => new Date() },
    idGen: { next: () => ulid() },
}

const DEFAULT_LEASE_TTL_MS = 30_000
const MAX_LEASE_TTL_MS = 300_000

const STATUS: Record<FabricErrorCode, number> = {
    SESSION_NOT_FOUND: 404,
    LEASE_HELD: 409,
    NO_LEASE: 409,
    LEASE_MISMATCH: 403,
    SEQ_CONFLICT: 409,
}

function sendResult<T>(res: import('express').Response, result: Result<T>, okStatus = 200): void {
    if (result.ok) {
        res.status(okStatus).json(result.value)
        return
    }
    res.status(STATUS[result.error.code]).json({ error: result.error })
}

// ── Schemas ─────────────────────────────────────────────────────

const createSessionBody = z.object({
    workspaceId: z.string().regex(UUID_RE),
    title: z.string().max(200).nullish(),
    policyTier: policyTierSchema.optional(),
})

const appendBody = z.object({
    runnerId: z.string().min(1).max(128),
    kind: sessionEventKindSchema,
    actorType: actorTypeSchema,
    actorId: z.string().max(128).nullish(),
    payload: z.unknown(),
    schemaVersion: z.number().int().positive().optional(),
    model: z.string().nullish(),
    provider: z.string().nullish(),
    tokensIn: z.number().int().nullish(),
    tokensOut: z.number().int().nullish(),
    costUsd: z.number().nullish(),
})

const participantBody = z.object({
    participantId: z.string().min(1).max(128),
    kind: participantKindSchema,
    surface: participantSurfaceSchema.nullish(),
    capabilities: z.unknown().optional(),
    role: participantRoleSchema.optional(),
})

const runnerBody = z.object({
    id: z.string().min(1).max(128),
    workspaceId: z.string().regex(UUID_RE).nullish(),
    backend: runnerBackendSchema,
    capabilities: z.unknown().optional(),
    status: runnerStatusSchema.optional(),
})

const leaseBody = z.object({
    runnerId: z.string().min(1).max(128),
    ttlMs: z.number().int().positive().max(MAX_LEASE_TTL_MS).optional(),
})

function badRequest(res: import('express').Response, err: z.ZodError): void {
    res.status(400).json({ error: { code: 'INVALID_BODY', message: err.issues[0]?.message ?? 'Invalid request body' } })
}

// ── Sessions ────────────────────────────────────────────────────

sessionFabricRouter.post('/sessions', async (req, res) => {
    const parsed = createSessionBody.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed.error)
    if (!req.user?.id) {
        res.status(400).json({ error: { code: 'MISSING_USER', message: 'authenticated user required to create a session' } })
        return
    }
    if (!(await ensureWorkspaceAccess(req, res, parsed.data.workspaceId))) return
    try {
        const session = await createSession(deps, {
            workspaceId: parsed.data.workspaceId,
            createdBy: req.user.id,
            title: parsed.data.title ?? null,
            policyTier: parsed.data.policyTier,
        })
        res.status(201).json(session)
    } catch (err) {
        logger.error({ err }, 'POST /sessions failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create session' } })
    }
})

sessionFabricRouter.get('/sessions', async (req, res) => {
    const workspaceId = (req.query.workspaceId as string) ?? ''
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!(await ensureWorkspaceAccess(req, res, workspaceId))) return
    try {
        const items = await listMasterSessions(deps, workspaceId)
        res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /sessions failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list sessions' } })
    }
})

async function loadSessionForAccess(
    req: import('express').Request,
    res: import('express').Response,
): Promise<{ workspaceId: string } | null> {
    const id = String(req.params.id ?? '')
    if (!id || id.length > 64) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid session id' } })
        return null
    }
    const session = await getSession(deps, id)
    if (!session) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } })
        return null
    }
    if (!(await ensureWorkspaceAccess(req, res, session.workspaceId))) return null
    return { workspaceId: session.workspaceId }
}

sessionFabricRouter.get('/sessions/:id', async (req, res) => {
    try {
        const id = req.params.id
        const session = await getSession(deps, id)
        if (!session) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Session not found' } })
            return
        }
        if (!(await ensureWorkspaceAccess(req, res, session.workspaceId))) return
        res.json(session)
    } catch (err) {
        logger.error({ err }, 'GET /sessions/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch session' } })
    }
})

// ── Events ──────────────────────────────────────────────────────

sessionFabricRouter.post('/sessions/:id/events', requireDeviceToken, killSwitchGuard, enforceEventTier, async (req, res) => {
    const parsed = appendBody.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed.error)
    try {
        if (!(await loadSessionForAccess(req, res))) return
        const result = await appendEvent(deps, { sessionId: String(req.params.id), ...parsed.data })
        sendResult(res, result, 201)
    } catch (err) {
        logger.error({ err, sessionId: String(req.params.id) }, 'POST /sessions/:id/events failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to append event' } })
    }
})

sessionFabricRouter.get('/sessions/:id/events', async (req, res) => {
    try {
        if (!(await loadSessionForAccess(req, res))) return
        const sinceSeq = Math.max(0, parseInt((req.query.sinceSeq as string) ?? '0', 10) || 0)
        const events = await replayEvents(deps, req.params.id, sinceSeq)
        res.json({ items: events, total: events.length })
    } catch (err) {
        logger.error({ err, sessionId: String(req.params.id) }, 'GET /sessions/:id/events failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to replay events' } })
    }
})

sessionFabricRouter.get('/sessions/:id/events/stream', async (req, res) => {
    const access = await loadSessionForAccess(req, res)
    if (!access) return

    const sessionId = req.params.id
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    let lastSeq = Math.max(0, parseInt((req.query.sinceSeq as string) ?? '0', 10) || 0) - 1
    let closed = false

    async function poll(): Promise<void> {
        if (closed) return
        try {
            const events = await replayEvents(deps, sessionId, lastSeq + 1)
            for (const e of events) {
                if (closed) return
                if (e.seq > lastSeq) lastSeq = e.seq
                res.write(`data: ${JSON.stringify({ type: 'event', data: e })}\n\n`)
            }
        } catch (err) {
            logger.error({ err, sessionId }, 'session-fabric stream poll error')
        }
    }

    await poll()
    if (closed) return

    const pollTimer = setInterval(poll, 2000)
    const pingTimer = setInterval(() => {
        if (!closed) res.write(': ping\n\n')
    }, 15000)

    req.on('close', () => {
        closed = true
        clearInterval(pollTimer)
        clearInterval(pingTimer)
    })
})

// ── Participants ────────────────────────────────────────────────

sessionFabricRouter.post('/sessions/:id/participants', requireDeviceToken, killSwitchGuard, enforceJoinTier, async (req, res) => {
    const parsed = participantBody.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed.error)
    try {
        if (!(await loadSessionForAccess(req, res))) return
        const participant = await joinParticipant(deps, { sessionId: String(req.params.id), ...parsed.data })
        res.status(200).json(participant)
    } catch (err) {
        logger.error({ err, sessionId: String(req.params.id) }, 'POST /sessions/:id/participants failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to join session' } })
    }
})

// ── Leases ──────────────────────────────────────────────────────

sessionFabricRouter.post('/sessions/:id/lease', requireDeviceToken, killSwitchGuard, enforceDriveTier, async (req, res) => {
    const parsed = leaseBody.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed.error)
    try {
        if (!(await loadSessionForAccess(req, res))) return
        const result = await claimLease(deps, {
            sessionId: String(req.params.id),
            runnerId: parsed.data.runnerId,
            ttlMs: parsed.data.ttlMs ?? DEFAULT_LEASE_TTL_MS,
        })
        sendResult(res, result, 201)
    } catch (err) {
        logger.error({ err, sessionId: String(req.params.id) }, 'POST /sessions/:id/lease failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to claim lease' } })
    }
})

sessionFabricRouter.post('/sessions/:id/lease/renew', requireDeviceToken, killSwitchGuard, enforceDriveTier, async (req, res) => {
    const parsed = leaseBody.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed.error)
    try {
        if (!(await loadSessionForAccess(req, res))) return
        const result = await renewLease(deps, {
            sessionId: String(req.params.id),
            runnerId: parsed.data.runnerId,
            ttlMs: parsed.data.ttlMs ?? DEFAULT_LEASE_TTL_MS,
        })
        sendResult(res, result)
    } catch (err) {
        logger.error({ err, sessionId: String(req.params.id) }, 'POST /sessions/:id/lease/renew failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to renew lease' } })
    }
})

sessionFabricRouter.delete('/sessions/:id/lease', async (req, res) => {
    const parsed = z.object({ runnerId: z.string().min(1).max(128) }).safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed.error)
    try {
        if (!(await loadSessionForAccess(req, res))) return
        const result = await releaseLease(deps, { sessionId: String(req.params.id), runnerId: parsed.data.runnerId })
        if (result.ok) {
            res.status(204).end()
            return
        }
        sendResult(res, result)
    } catch (err) {
        logger.error({ err, sessionId: String(req.params.id) }, 'DELETE /sessions/:id/lease failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to release lease' } })
    }
})

// ── Runners ─────────────────────────────────────────────────────

sessionFabricRouter.post('/runners', async (req, res) => {
    const parsed = runnerBody.safeParse(req.body)
    if (!parsed.success) return badRequest(res, parsed.error)
    if (parsed.data.workspaceId) {
        if (!(await ensureWorkspaceAccess(req, res, parsed.data.workspaceId))) return
    }
    try {
        const runner = await registerRunner(deps, {
            id: parsed.data.id,
            workspaceId: parsed.data.workspaceId ?? null,
            backend: parsed.data.backend,
            capabilities: parsed.data.capabilities,
            status: parsed.data.status,
        })
        res.status(200).json(runner)
    } catch (err) {
        logger.error({ err }, 'POST /runners failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to register runner' } })
    }
})
