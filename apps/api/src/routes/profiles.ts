// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * App Profile Registration API
 *
 * GET  /api/profiles            — List registered app profiles
 * POST /api/profiles/register  — Register or re-register an app profile
 *
 * App profiles are external Joeybuilt apps (fylo, fonto, levio, etc.) that
 * register their identity, schema namespace, PEX extensions, and event
 * contracts with this Core instance.
 */

import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import { db, eq, sql } from '@plexo/db'
import { appProfiles, extensionRegistry } from '@plexo/db'
import { logger } from '../logger.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { negotiateProfile } from '../profile-negotiation.js'
import { UUID_RE } from '../validation.js'
import { PEX_CONTRACT_VERSION, isContractCompatible } from '@joeybuilt/plexo-sdk'

export const profilesRouter: RouterType = Router()

// ── Zod Schema ──────────────────────────────────────────────────────────────

const NAMESPACE_RE = /^[a-z][a-z0-9_]*$/

const extensionSchema = z.object({
    id: z.string().min(1),
    type: z.enum(['agent', 'skill', 'channel', 'tool', 'connector']),
    name: z.string().min(1),
    config: z.record(z.unknown()).default({}),
})

export const profileRegisterSchema = z.object({
    appId: z.string().min(1),
    schemaNamespace: z.string().regex(NAMESPACE_RE, 'Must be lowercase alphanumeric + underscore, starting with a letter'),
    displayName: z.string().min(1),
    extensions: z.array(extensionSchema).default([]),
    eventContracts: z.array(z.string()).default([]),
})

export type ProfileRegisterBody = z.infer<typeof profileRegisterSchema>

const profileSchema = z.object({
    connectors: z.array(z.string()).default([]),
    capabilities: z.array(z.string()).default([]),
})

export const negotiateSchema = z.object({
    workspaceId: z.string().regex(UUID_RE, 'workspaceId must be a valid UUID'),
    requestedProfile: profileSchema.optional(),
})

export const connectSchema = z.object({
    contractVersion: z.string().min(1),
    workspaceId: z.string().regex(UUID_RE, 'workspaceId must be a valid UUID').optional(),
    requestedProfile: profileSchema.optional(),
})

// ── GET / — list registered profiles ─────────────────────────────────────────

profilesRouter.get('/', requireServiceKey, async (_req, res) => {
    try {
        const rows = await db
            .select({
                appId: appProfiles.appId,
                schemaNamespace: appProfiles.schemaNamespace,
                displayName: appProfiles.displayName,
                lastSeenAt: appProfiles.lastSeenAt,
            })
            .from(appProfiles)
            .orderBy(appProfiles.registeredAt)

        return res.json({ items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/profiles failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list profiles' } })
    }
})

// ── POST /register ──────────────────────────────────────────────────────────

profilesRouter.post('/register', requireServiceKey, async (req, res) => {
    try {
        const parsed = profileRegisterSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { appId, schemaNamespace, displayName, extensions: exts, eventContracts } = parsed.data

        // Upsert app_profiles on app_id
        await db
            .insert(appProfiles)
            .values({
                appId,
                schemaNamespace,
                displayName,
                eventContracts: eventContracts,
                lastSeenAt: new Date(),
            })
            .onConflictDoUpdate({
                target: appProfiles.appId,
                set: {
                    displayName,
                    eventContracts: eventContracts,
                    lastSeenAt: new Date(),
                },
            })

        // Upsert each extension into the extension_registry (append-never-overwrite).
        // We register them under the app's namespace so they're discoverable.
        for (const ext of exts) {
            const registryName = `@${appId}/${ext.id}`
            await db
                .insert(extensionRegistry)
                .values({
                    name: registryName,
                    displayName: ext.name,
                    description: `${ext.type} extension from ${displayName}`,
                    publisher: appId,
                    latestVersion: '0.0.0',
                    versions: ['0.0.0'],
                    manifest: { type: ext.type, config: ext.config },
                    tags: [ext.type, appId],
                })
                .onConflictDoUpdate({
                    target: extensionRegistry.name,
                    set: {
                        displayName: ext.name,
                        description: `${ext.type} extension from ${displayName}`,
                        manifest: { type: ext.type, config: ext.config },
                        tags: [ext.type, appId],
                        updatedAt: new Date(),
                    },
                })
        }

        // Update last_seen_at (redundant with upsert above but ensures timing accuracy)
        await db
            .update(appProfiles)
            .set({ lastSeenAt: new Date() })
            .where(eq(appProfiles.appId, appId))

        logger.info({ event: 'profile_register', appId, schemaNamespace }, 'App profile registered')

        return res.json({ ok: true, appId, schemaNamespace })
    } catch (err) {
        logger.error({ err }, 'Profile registration failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Registration failed' } })
    }
})

// ── POST /negotiate ───────────────────────────────────────────────────────────
// Connection & Profile Standard (ADR 0001 §3). The app (identified by X-App-Id)
// declares a requestedProfile for a workspace; the server returns the effective
// profile = intersection(requested, granted), default-deny. No grant yet → a
// 'pending' proposal is captured for the operator and an empty profile returned.

profilesRouter.post('/negotiate', requireServiceKey, async (req, res) => {
    try {
        const appId = req.serviceContext?.appId
        if (!appId) {
            return res.status(400).json({ error: { code: 'MISSING_APP_ID', message: 'X-App-Id header required' } })
        }
        const parsed = negotiateSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
            })
        }
        const result = await negotiateProfile({
            appId,
            workspaceId: parsed.data.workspaceId,
            requestedProfile: parsed.data.requestedProfile ?? null,
        })
        logger.info({ event: 'profile_negotiate', appId, workspaceId: parsed.data.workspaceId, status: result.status }, 'Profile negotiated')
        return res.json(result)
    } catch (err) {
        logger.error({ err }, 'Profile negotiation failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Negotiation failed' } })
    }
})

// ── POST /connect ─────────────────────────────────────────────────────────────
// Connection & Profile Standard (ADR 0001 §5) — the connect() handshake. The app
// declares its contract version; the server advertises its own (the client
// negotiates to a common MAJOR and fails loud on mismatch). When a workspaceId is
// supplied AND the versions are compatible, the effective profile is negotiated
// in the same round-trip (default-deny; pending proposal captured if ungranted).

profilesRouter.post('/connect', requireServiceKey, async (req, res) => {
    try {
        const appId = req.serviceContext?.appId
        if (!appId) {
            return res.status(400).json({ error: { code: 'MISSING_APP_ID', message: 'X-App-Id header required' } })
        }
        const parsed = connectSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', details: parsed.error.flatten().fieldErrors },
            })
        }
        const { contractVersion, workspaceId, requestedProfile } = parsed.data
        const compatible = isContractCompatible(contractVersion, PEX_CONTRACT_VERSION)

        const empty = { connectors: [], capabilities: [] }
        if (!compatible) {
            // Fail-loud signal: client checks serverContractVersion + this code.
            logger.warn({ event: 'profile_connect', appId, contractVersion, serverContractVersion: PEX_CONTRACT_VERSION }, 'Connect rejected — incompatible contract major')
            return res.json({ serverContractVersion: PEX_CONTRACT_VERSION, compatible, code: 'PROTOCOL_VERSION_UNSUPPORTED', status: 'unscoped', effectiveProfile: empty })
        }

        if (workspaceId) {
            const result = await negotiateProfile({ appId, workspaceId, requestedProfile: requestedProfile ?? null })
            logger.info({ event: 'profile_connect', appId, workspaceId, status: result.status }, 'Connected + profile negotiated')
            return res.json({ serverContractVersion: PEX_CONTRACT_VERSION, compatible, status: result.status, effectiveProfile: result.effectiveProfile })
        }

        logger.info({ event: 'profile_connect', appId }, 'Connected (no workspace — unscoped)')
        return res.json({ serverContractVersion: PEX_CONTRACT_VERSION, compatible, status: 'unscoped', effectiveProfile: empty })
    } catch (err) {
        logger.error({ err }, 'Profile connect failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Connect failed' } })
    }
})
