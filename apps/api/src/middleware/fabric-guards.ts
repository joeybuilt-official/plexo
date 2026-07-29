// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric security guards — Express adapters (Phase 1c).
 *
 * Thin middleware that translate HTTP → domain calls: verify the device token,
 * enforce the tier matrix + per-session drive grant, and block every mutation
 * while the kill switch is engaged. All decisions come from the pure domain
 * (`verifyClaims`, `tierAllows`, `killGuard`, `eventKindMinTier`); the ports are
 * injected so the composition root wires the concrete valkey/jose adapters.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import {
    eventKindMinTier,
    killGuard,
    tierAllows,
    tierAtLeast,
    verifyClaims,
    buildAuditRecord,
    type AuditSink,
    type DeviceTokenClaims,
    type GrantStore,
    type KillSwitchStore,
    type RevocationStore,
    type SessionEventKind,
    type Tier,
    type TokenSigner,
} from '@plexo/session-fabric'
import { sessionEventKind } from '@plexo/session-fabric'

declare global {
    namespace Express {
        interface Request {
            deviceToken?: DeviceTokenClaims
        }
    }
}

export interface GuardDeps {
    signer: TokenSigner
    revocations: RevocationStore
    killSwitch: KillSwitchStore
    grants: GrantStore
    audit: AuditSink
}

function readToken(req: Request): string | null {
    const header = req.get('x-fabric-device-token')
    if (header) return header.trim()
    const auth = req.get('authorization')
    if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
    return null
}

function deny(req: Request, res: Response, deps: GuardDeps, status: number, code: string, message: string): void {
    void deps.audit.append(
        buildAuditRecord('action.denied', new Date(), {
            actorId: req.deviceToken?.participantId ?? req.user?.id ?? null,
            workspaceId: req.deviceToken?.workspaceId ?? null,
            sessionId: typeof req.params.id === 'string' ? req.params.id : null,
            detail: { code, message, path: req.path, method: req.method },
        }),
    )
    res.status(status).json({ error: { code, message } })
}

export function makeRequireDeviceToken(deps: GuardDeps): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const token = readToken(req)
            if (!token) return deny(req, res, deps, 401, 'DEVICE_TOKEN_REQUIRED', 'A fabric device token is required')

            const payload = await deps.signer.verifySignature(token)
            if (payload === null) return deny(req, res, deps, 401, 'DEVICE_TOKEN_INVALID', 'Device token signature is invalid')

            const result = verifyClaims(payload, Math.floor(Date.now() / 1000))
            if (!result.ok) {
                const code = result.reason === 'expired' ? 'DEVICE_TOKEN_EXPIRED' : 'DEVICE_TOKEN_INVALID'
                return deny(req, res, deps, 401, code, `Device token ${result.reason}`)
            }

            if (await deps.revocations.isRevoked(result.claims.jti)) {
                req.deviceToken = result.claims
                return deny(req, res, deps, 401, 'DEVICE_TOKEN_REVOKED', 'Device token has been revoked')
            }

            req.deviceToken = result.claims
            next()
        } catch (err) {
            deps.audit.append(
                buildAuditRecord('action.denied', new Date(), { detail: { err: (err as Error).message } }),
            )
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Device token check failed' } })
        }
    }
}

export function makeKillSwitchGuard(deps: GuardDeps): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const guard = killGuard(await deps.killSwitch.state())
            if (guard.allow) return next()
            deny(req, res, deps, 503, 'KILL_SWITCH_ENGAGED', `Fabric mutations are halted: ${guard.reason}`)
        } catch (err) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Kill-switch check failed' } })
        }
    }
}

async function enforce(
    deps: GuardDeps,
    req: Request,
    res: Response,
    next: NextFunction,
    required: Tier,
    actionKind: 'read' | 'message' | 'approve' | 'mutate',
): Promise<void> {
    const claims = req.deviceToken
    if (!claims) return deny(req, res, deps, 401, 'DEVICE_TOKEN_REQUIRED', 'A fabric device token is required')
    if (!tierAllows(claims.tier, actionKind) || !tierAtLeast(claims.tier, required)) {
        return deny(req, res, deps, 403, 'TIER_INSUFFICIENT', `This action requires the ${required} tier`)
    }
    try {
        if (required === 'drive') {
            const sessionId = String(req.params.id ?? '')
            if (!(await deps.grants.hasGrant(sessionId, claims.participantId))) {
                return deny(req, res, deps, 403, 'DRIVE_GRANT_REQUIRED', 'A per-session drive grant is required')
            }
        }
        next()
    } catch (err) {
        // Fail closed: a grant-store (valkey) error must not hang the request or open the gate.
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Tier check failed' } })
    }
}

/** Fixed minimum tier for a route (e.g. lease claim/renew, join-as-driver = drive). */
export function makeEnforceTier(deps: GuardDeps, required: Tier): RequestHandler {
    return (req, res, next) =>
        enforce(deps, req, res, next, required, required === 'drive' ? 'mutate' : required === 'steer' ? 'message' : 'read')
}

/** Derives the required tier from the appended event kind in the request body. */
export function makeEnforceEventTier(deps: GuardDeps): RequestHandler {
    return (req, res, next) => {
        const parsed = sessionEventKind.safeParse((req.body as { kind?: unknown })?.kind)
        const kind: SessionEventKind = parsed.success ? parsed.data : 'tool_call'
        const required = eventKindMinTier(kind)
        return enforce(deps, req, res, next, required, required === 'drive' ? 'mutate' : 'message')
    }
}

/** Only enforces drive when a participant joins with role=driver. */
export function makeEnforceJoinTier(deps: GuardDeps): RequestHandler {
    return (req, res, next) => {
        if ((req.body as { role?: unknown })?.role === 'driver') {
            return enforce(deps, req, res, next, 'drive', 'mutate')
        }
        next()
    }
}
