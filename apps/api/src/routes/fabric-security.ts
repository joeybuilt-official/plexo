// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric security bar — composition root + operator endpoints (Phase 1c).
 *
 * Wires the concrete adapters (jose signer, valkey stores) to the domain ports
 * once, exports the configured guards for `routes/sessions.ts`, and serves the
 * operator surface: issue/revoke device tokens, toggle the global kill switch,
 * grant per-session drive, and evaluate the D9 policy contract.
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { Router, type NextFunction, type Request, type Response, type Router as ExpressRouter } from 'express'
import { ulid } from 'ulid'
import { z } from 'zod'
import {
    buildAuditRecord,
    deviceTokenClaims,
    evaluatePolicy,
    policyDocument,
    policyTier,
    type PolicyRule,
} from '@plexo/session-fabric'
import { DEFAULT_DEVICE_TOKEN_TTL_S, makeTokenSigner } from '../middleware/fabric-token.js'
import {
    makeAuditSink,
    makeGrantStore,
    makeKillSwitchStore,
    makeRevocationStore,
} from '../repositories/fabric-security.repository.js'
import {
    makeEnforceEventTier,
    makeEnforceJoinTier,
    makeEnforceTier,
    makeKillSwitchGuard,
    makeRequireDeviceToken,
    type GuardDeps,
} from '../middleware/fabric-guards.js'
import { requireSuperAdmin } from '../middleware/super-admin.js'
import { logger } from '../logger.js'

// ── Composition root ────────────────────────────────────────────

const signer = makeTokenSigner()
const revocations = makeRevocationStore()
const killSwitch = makeKillSwitchStore()
const grants = makeGrantStore()
const audit = makeAuditSink()

const guardDeps: GuardDeps = { signer, revocations, killSwitch, grants, audit }

// Guards consumed by routes/sessions.ts to protect mutating endpoints.
export const requireDeviceToken = makeRequireDeviceToken(guardDeps)
export const killSwitchGuard = makeKillSwitchGuard(guardDeps)
export const enforceEventTier = makeEnforceEventTier(guardDeps)
export const enforceJoinTier = makeEnforceJoinTier(guardDeps)
export const enforceDriveTier = makeEnforceTier(guardDeps, 'drive')

/**
 * Opt-in Cloudflare Access edge check. When enabled, requires the
 * `Cf-Access-Jwt-Assertion` header that tunnel-daemon injects on tunnel ingress.
 * ponytail: presence-only trust rests on the tunnel being the SOLE ingress
 * (only tunnel-daemon can set this header on our network). Upgrade path = verify
 * the assertion against the team JWKS (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs)
 * with jose's createRemoteJWKSet before granting access.
 */
export function cfAccessGuard(req: Request, res: Response, next: NextFunction): void {
    if (process.env.FABRIC_CF_ACCESS_ENABLED !== 'true') return next()
    if (!req.get('cf-access-jwt-assertion')) {
        res.status(401).json({ error: { code: 'CF_ACCESS_REQUIRED', message: 'Cloudflare Access assertion missing' } })
        return
    }
    next()
}

// ── Policy loader adapter (D9) ──────────────────────────────────

let cachedRules: PolicyRule[] | null = null

function loadPolicyRules(): PolicyRule[] {
    if (cachedRules) return cachedRules
    const require = createRequire(import.meta.url)
    const path = require.resolve('@plexo/session-fabric/policy/fabric-policy.json')
    const doc = policyDocument.parse(JSON.parse(readFileSync(path, 'utf8')))
    cachedRules = doc.rules
    return cachedRules
}

// ── Router ──────────────────────────────────────────────────────

export const fabricSecurityRouter: ExpressRouter = Router()

/** Max device-token lifetime (s). Revocation must outlast this to be reliable. */
const MAX_DEVICE_TOKEN_TTL_S = 86_400

const issueTokenBody = z.object({
    deviceId: z.string().min(1).max(128),
    participantId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    tier: policyTier,
    ttlSec: z.number().int().positive().max(MAX_DEVICE_TOKEN_TTL_S).optional(),
})

fabricSecurityRouter.post('/fabric/tokens', requireSuperAdmin, cfAccessGuard, async (req, res) => {
    const parsed = issueTokenBody.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'Invalid body' } })
        return
    }
    try {
        const now = Math.floor(Date.now() / 1000)
        const claims = deviceTokenClaims.parse({
            ...parsed.data,
            jti: ulid(),
            iat: now,
            exp: now + (parsed.data.ttlSec ?? DEFAULT_DEVICE_TOKEN_TTL_S),
        })
        const token = await signer.sign(claims)
        await audit.append(
            buildAuditRecord('token.issue', new Date(), {
                actorId: req.user?.id ?? null,
                workspaceId: claims.workspaceId,
                detail: { jti: claims.jti, participantId: claims.participantId, tier: claims.tier, exp: claims.exp },
            }),
        )
        res.status(201).json({ token, jti: claims.jti, exp: claims.exp })
    } catch (err) {
        logger.error({ err }, 'POST /fabric/tokens failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to issue device token' } })
    }
})

fabricSecurityRouter.delete('/fabric/tokens/:jti', requireSuperAdmin, cfAccessGuard, async (req, res) => {
    const jti = String(req.params.jti ?? '')
    if (!jti || jti.length > 128) {
        res.status(400).json({ error: { code: 'INVALID_JTI', message: 'Invalid jti' } })
        return
    }
    try {
        // Deny the jti for the MAX possible token lifetime — a client-supplied
        // (or default-900s) TTL shorter than the token's own exp would let a
        // revoked long-lived token be re-accepted once the denylist entry expired.
        const ttl = Math.floor(Date.now() / 1000) + MAX_DEVICE_TOKEN_TTL_S
        await revocations.revoke(jti, ttl)
        await audit.append(
            buildAuditRecord('token.revoke', new Date(), { actorId: req.user?.id ?? null, detail: { jti } }),
        )
        res.status(204).end()
    } catch (err) {
        logger.error({ err }, 'DELETE /fabric/tokens/:jti failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke device token' } })
    }
})

fabricSecurityRouter.post('/fabric/kill', requireSuperAdmin, cfAccessGuard, async (req, res) => {
    const reason = typeof (req.body as { reason?: unknown })?.reason === 'string' ? (req.body as { reason: string }).reason : 'engaged'
    try {
        await killSwitch.engage(reason)
        await audit.append(buildAuditRecord('kill.engage', new Date(), { actorId: req.user?.id ?? null, detail: { reason } }))
        res.status(200).json({ engaged: true, reason })
    } catch (err) {
        logger.error({ err }, 'POST /fabric/kill failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to engage kill switch' } })
    }
})

fabricSecurityRouter.delete('/fabric/kill', requireSuperAdmin, cfAccessGuard, async (req, res) => {
    try {
        await killSwitch.release()
        await audit.append(buildAuditRecord('kill.release', new Date(), { actorId: req.user?.id ?? null }))
        res.status(200).json({ engaged: false })
    } catch (err) {
        logger.error({ err }, 'DELETE /fabric/kill failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to release kill switch' } })
    }
})

const grantBody = z.object({
    participantId: z.string().min(1).max(128),
    ttlSec: z.number().int().positive().max(86_400).optional(),
})

fabricSecurityRouter.post('/sessions/:id/grant', requireSuperAdmin, cfAccessGuard, killSwitchGuard, async (req, res) => {
    const parsed = grantBody.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'Invalid body' } })
        return
    }
    const sessionId = String(req.params.id ?? '')
    try {
        // ponytail: valkey grant is the migration-free source of truth; the durable
        // mirror onto session_participants.role lands with the fabric migration.
        await grants.grant(sessionId, parsed.data.participantId, parsed.data.ttlSec ?? 3600)
        await audit.append(
            buildAuditRecord('drive.grant', new Date(), {
                actorId: req.user?.id ?? null,
                sessionId,
                detail: { participantId: parsed.data.participantId, ttlSec: parsed.data.ttlSec ?? 3600 },
            }),
        )
        res.status(200).json({ sessionId, participantId: parsed.data.participantId, tier: 'drive' })
    } catch (err) {
        logger.error({ err, sessionId }, 'POST /sessions/:id/grant failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to grant drive tier' } })
    }
})

// Bound every field: policy patterns are operator-authored regexes tested via
// RegExp.test — an unbounded `cmd` + a backtracking pattern would hang the loop.
const evaluateBody = z.object({
    action: z.object({
        tool: z.string().max(512).optional(),
        cmd: z.string().max(4096).optional(),
        cwd: z.string().max(4096).optional(),
        path: z.string().max(4096).optional(),
    }),
    tier: policyTier.default('steer'),
})

fabricSecurityRouter.post('/sessions/:id/policy/evaluate', requireDeviceToken, async (req, res) => {
    const parsed = evaluateBody.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: parsed.error.issues[0]?.message ?? 'Invalid body' } })
        return
    }
    try {
        const evaluation = evaluatePolicy(parsed.data.action, parsed.data.tier, loadPolicyRules())
        res.status(200).json(evaluation)
    } catch (err) {
        logger.error({ err }, 'POST /sessions/:id/policy/evaluate failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to evaluate policy' } })
    }
})
