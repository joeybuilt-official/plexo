// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PAX (Plexo Application eXchange) — registration API
 *
 * POST   /api/v1/pax/register        — validate pax.json, issue token, store record
 * GET    /api/v1/pax/info            — host compliance level declaration
 * GET    /api/v1/pax/status/:appName — registration info for an app
 * POST   /api/v1/pax/rotate          — rotate token (auth: existing PAX token)
 * DELETE /api/v1/pax/register/:appName — revoke (auth: workspace API key)
 */
import { Router, type Router as RouterType } from 'express'
import { createHash, randomBytes } from 'node:crypto'
import { db, eq, and, sql } from '@plexo/db'
import { paxRegistrations, mcpTokens, workspaces } from '@plexo/db'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

export const paxRouter: RouterType = Router()

// ── Manifest validation ──────────────────────────────────────────────────────

const PAX_NAME_RE = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/
const CAPABILITY_RE = /^(ai:(complete|embed)|memory:(read|write|search):[a-z0-9:.]+|events:(publish|subscribe):[a-z0-9:.]+|entities:(read|create):[a-z_]+|agents:invoke|connections:proxy:[a-z0-9*-]+)$/

interface PaxManifest {
    plexo: string
    name: string
    version: string
    displayName: string
    description: string
    author: string
    license: string
    capabilities?: string[]
    memoryNamespace?: string
    eventNamespace?: string
    events?: { publishes?: string[]; subscribes?: string[] }
    dataResidency?: { regions?: string[]; compliance?: string[] }
    entities?: string[]
    workspace?: string
}

interface ManifestError {
    field: string
    message: string
    value?: unknown
}

function validateManifest(m: unknown): { ok: true; manifest: PaxManifest } | { ok: false; errors: ManifestError[] } {
    const errors: ManifestError[] = []
    if (!m || typeof m !== 'object') return { ok: false, errors: [{ field: 'manifest', message: 'Must be a JSON object' }] }

    const obj = m as Record<string, unknown>

    // Required string fields
    for (const field of ['plexo', 'name', 'version', 'displayName', 'description', 'author', 'license'] as const) {
        if (typeof obj[field] !== 'string' || !obj[field]) {
            errors.push({ field, message: `Required string field '${field}' is missing or empty` })
        }
    }

    if (errors.length > 0) return { ok: false, errors }

    if (obj.plexo !== '0.1.0') {
        errors.push({ field: 'plexo', message: "Must be '0.1.0'", value: obj.plexo })
    }
    if (!PAX_NAME_RE.test(obj.name as string)) {
        errors.push({ field: 'name', message: 'Must match /^(@[a-z0-9-]+\\/)?[a-z0-9-]+$/', value: obj.name })
    }
    if (!SEMVER_RE.test(obj.version as string)) {
        errors.push({ field: 'version', message: 'Must be valid semver', value: obj.version })
    }

    // Optional: capabilities
    if (obj.capabilities !== undefined) {
        if (!Array.isArray(obj.capabilities)) {
            errors.push({ field: 'capabilities', message: 'Must be an array of strings' })
        } else {
            for (const cap of obj.capabilities) {
                if (typeof cap !== 'string' || !CAPABILITY_RE.test(cap)) {
                    errors.push({ field: 'capabilities', message: `Invalid capability token: '${cap}'`, value: cap })
                }
            }
        }
    }

    // Optional: memoryNamespace
    if (obj.memoryNamespace !== undefined) {
        if (typeof obj.memoryNamespace !== 'string' || !obj.memoryNamespace.startsWith('pax:')) {
            errors.push({ field: 'memoryNamespace', message: "Must start with 'pax:'" })
        }
    }

    // Optional: eventNamespace
    if (obj.eventNamespace !== undefined) {
        if (typeof obj.eventNamespace !== 'string' || !obj.eventNamespace.startsWith('pax.')) {
            errors.push({ field: 'eventNamespace', message: "Must start with 'pax.'" })
        }
    }

    if (errors.length > 0) return { ok: false, errors }
    return { ok: true, manifest: obj as unknown as PaxManifest }
}

// ── Token helpers (reuse MCP pattern) ────────────────────────────────────────

function generatePaxToken(): { rawToken: string; hash: string; salt: string } {
    const rawToken = 'plx_' + randomBytes(32).toString('base64url')
    const salt = randomBytes(32).toString('hex')
    const hash = createHash('sha256').update(rawToken + salt).digest('hex')
    return { rawToken, hash, salt }
}

function hashManifest(manifest: PaxManifest): string {
    return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

// ── Capability ceiling check (§4.2) ──────────────────────────────────────────

const ADMIN_REQUIRED_CAPS = ['memory:write:*', 'entities:create:*', 'connections:proxy:*']

function checkCapabilityCeiling(capabilities: string[]): string[] {
    const denied: string[] = []
    for (const cap of capabilities) {
        for (const pattern of ADMIN_REQUIRED_CAPS) {
            // Exact match on wildcard patterns
            if (cap === pattern) denied.push(cap)
        }
    }
    return denied
}

// ── Default token expiry ─────────────────────────────────────────────────────

const DEFAULT_EXPIRY_DAYS = 90

function defaultExpiry(): Date {
    const d = new Date()
    d.setDate(d.getDate() + DEFAULT_EXPIRY_DAYS)
    return d
}

// ── POST /register — validate pax.json, issue token ─────────────────────────

paxRouter.post('/register', async (req, res) => {
    try {
        const workspaceId = req.headers['x-workspace-id'] as string | undefined
        if (!workspaceId || !UUID_RE.test(workspaceId)) {
            return res.status(400).json({ error: { code: 'PAX_WORKSPACE_NOT_FOUND', message: 'Valid X-Workspace-Id header required' } })
        }

        if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

        // Verify workspace exists
        const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) {
            return res.status(404).json({ error: { code: 'PAX_WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
        }

        const { manifest } = req.body ?? {}
        const validation = validateManifest(manifest)
        if (!validation.ok) {
            return res.status(400).json({
                error: {
                    code: 'PAX_MANIFEST_INVALID',
                    message: 'Manifest validation failed',
                    detail: validation.errors,
                },
            })
        }

        const m = validation.manifest

        // Check capability ceiling
        const caps = m.capabilities ?? []
        const denied = checkCapabilityCeiling(caps)
        if (denied.length > 0) {
            return res.status(403).json({
                error: {
                    code: 'PAX_CAP_DENIED',
                    message: 'Capabilities require explicit admin approval',
                    detail: { denied },
                },
            })
        }

        // Check registration conflict
        const [existing] = await db
            .select({ id: paxRegistrations.id })
            .from(paxRegistrations)
            .where(and(eq(paxRegistrations.workspaceId, workspaceId), eq(paxRegistrations.appName, m.name)))
            .limit(1)

        if (existing) {
            return res.status(409).json({
                error: { code: 'PAX_REGISTRATION_CONFLICT', message: `App '${m.name}' is already registered in this workspace` },
            })
        }

        // Generate token and store in mcp_tokens with type='pax'
        const { rawToken, hash, salt } = generatePaxToken()
        const expiresAt = defaultExpiry()
        const scopes = caps.length > 0 ? caps : ['ai:complete']

        const [tokenRow] = await db.insert(mcpTokens).values({
            workspaceId,
            name: `pax:${m.name}`,
            tokenHash: hash,
            tokenSalt: salt,
            scopes,
            type: 'pax',
            expiresAt,
        }).returning({ id: mcpTokens.id })

        // Store PAX registration
        await db.insert(paxRegistrations).values({
            appName: m.name,
            workspaceId,
            version: m.version,
            manifestHash: hashManifest(m),
            capabilities: scopes,
            tokenId: tokenRow!.id,
            tokenExpiresAt: expiresAt,
        })

        logger.info({ event: 'pax_register', appName: m.name, workspaceId }, 'PAX app registered')

        return res.status(201).json({
            ok: true,
            appName: m.name,
            token: rawToken,
            capabilities: scopes,
            expiresAt: expiresAt.toISOString(),
            message: 'Registration complete. Store this token securely — it will not be shown again.',
        })
    } catch (err) {
        logger.error({ err }, 'PAX register failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Registration failed' } })
    }
})

// ── GET /info — host compliance level ────────────────────────────────────────

paxRouter.get('/info', (_req, res) => {
    return res.json({
        paxVersion: '0.1.0',
        complianceLevel: 'basic',
        supportedCapabilities: [
            'ai:complete',
            'ai:embed',
            'memory:read',
            'memory:write',
            'memory:search',
            'events:publish',
            'events:subscribe',
            'entities:read',
            'entities:create',
            'agents:invoke',
            'connections:proxy',
        ],
    })
})

// ── GET /status/:appName — registration info ─────────────────────────────────

paxRouter.get('/status/:appName', async (req, res) => {
    try {
        const workspaceId = req.headers['x-workspace-id'] as string | undefined
        if (!workspaceId || !UUID_RE.test(workspaceId)) {
            return res.status(400).json({ error: { code: 'PAX_WORKSPACE_NOT_FOUND', message: 'Valid X-Workspace-Id header required' } })
        }

        if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

        const { appName } = req.params
        const [reg] = await db
            .select()
            .from(paxRegistrations)
            .where(and(eq(paxRegistrations.workspaceId, workspaceId), eq(paxRegistrations.appName, appName!)))
            .limit(1)

        if (!reg) {
            return res.status(404).json({ error: { code: 'PAX_WORKSPACE_NOT_FOUND', message: `App '${appName}' not found` } })
        }

        return res.json({
            appName: reg.appName,
            version: reg.version,
            capabilities: reg.capabilities,
            manifestHash: reg.manifestHash,
            issuedAt: reg.issuedAt.toISOString(),
            lastUsedAt: reg.lastUsedAt?.toISOString() ?? null,
            tokenExpiresAt: reg.tokenExpiresAt?.toISOString() ?? null,
            revoked: reg.revokedAt !== null,
            revokedAt: reg.revokedAt?.toISOString() ?? null,
        })
    } catch (err) {
        logger.error({ err }, 'PAX status failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Status check failed' } })
    }
})

// ── POST /rotate — rotate token ──────────────────────────────────────────────

paxRouter.post('/rotate', async (req, res) => {
    try {
        const { appName } = req.body ?? {}
        if (!appName || typeof appName !== 'string') {
            return res.status(400).json({ error: { code: 'PAX_MANIFEST_INVALID', message: 'appName is required' } })
        }

        const workspaceId = req.headers['x-workspace-id'] as string | undefined
        if (!workspaceId || !UUID_RE.test(workspaceId)) {
            return res.status(400).json({ error: { code: 'PAX_WORKSPACE_NOT_FOUND', message: 'Valid X-Workspace-Id header required' } })
        }

        if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

        const [reg] = await db
            .select()
            .from(paxRegistrations)
            .where(and(eq(paxRegistrations.workspaceId, workspaceId), eq(paxRegistrations.appName, appName)))
            .limit(1)

        if (!reg) {
            return res.status(404).json({ error: { code: 'PAX_WORKSPACE_NOT_FOUND', message: `App '${appName}' not found` } })
        }

        if (reg.revokedAt) {
            return res.status(401).json({ error: { code: 'PAX_TOKEN_REVOKED', message: 'Registration has been revoked' } })
        }

        // Revoke old token
        await db.update(mcpTokens).set({ revoked: true }).where(eq(mcpTokens.id, reg.tokenId))

        // Generate new token
        const { rawToken, hash, salt } = generatePaxToken()
        const expiresAt = defaultExpiry()

        const [newTokenRow] = await db.insert(mcpTokens).values({
            workspaceId,
            name: `pax:${appName}`,
            tokenHash: hash,
            tokenSalt: salt,
            scopes: reg.capabilities,
            type: 'pax',
            expiresAt,
        }).returning({ id: mcpTokens.id })

        // Update registration
        await db.update(paxRegistrations).set({
            tokenId: newTokenRow!.id,
            tokenExpiresAt: expiresAt,
        }).where(eq(paxRegistrations.id, reg.id))

        logger.info({ event: 'pax_rotate', appName, workspaceId }, 'PAX token rotated')

        return res.json({
            ok: true,
            appName,
            token: rawToken,
            expiresAt: expiresAt.toISOString(),
            message: 'Token rotated. Store this token securely — it will not be shown again.',
        })
    } catch (err) {
        logger.error({ err }, 'PAX rotate failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Token rotation failed' } })
    }
})

// ── DELETE /register/:appName — revoke ───────────────────────────────────────

paxRouter.delete('/register/:appName', async (req, res) => {
    try {
        const workspaceId = req.headers['x-workspace-id'] as string | undefined
        if (!workspaceId || !UUID_RE.test(workspaceId)) {
            return res.status(400).json({ error: { code: 'PAX_WORKSPACE_NOT_FOUND', message: 'Valid X-Workspace-Id header required' } })
        }

        if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

        const { appName } = req.params
        const [reg] = await db
            .select()
            .from(paxRegistrations)
            .where(and(eq(paxRegistrations.workspaceId, workspaceId), eq(paxRegistrations.appName, appName!)))
            .limit(1)

        if (!reg) {
            return res.status(404).json({ error: { code: 'PAX_WORKSPACE_NOT_FOUND', message: `App '${appName}' not found` } })
        }

        // Revoke token
        await db.update(mcpTokens).set({ revoked: true }).where(eq(mcpTokens.id, reg.tokenId))

        // Mark registration as revoked
        await db.update(paxRegistrations).set({ revokedAt: new Date() }).where(eq(paxRegistrations.id, reg.id))

        logger.info({ event: 'pax_revoke', appName, workspaceId }, 'PAX app revoked')

        return res.json({ ok: true, appName, message: 'Registration revoked' })
    } catch (err) {
        logger.error({ err }, 'PAX revoke failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Revocation failed' } })
    }
})
