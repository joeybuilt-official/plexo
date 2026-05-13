// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Tool Registry API (§12) — DB table: extensionRegistry
 *
 * Public discovery and publishing of tools.
 *
 * GET    /api/v1/registry                Search/list tools
 * GET    /api/v1/registry/:name          Get tool details (URL-encoded scoped name)
 * POST   /api/v1/registry                Publish/update a tool (auth required)
 * DELETE /api/v1/registry/:name          Deprecate a tool (auth required)
 *
 * Install flow: calls GET /registry/:name to get the manifest,
 * then POST /api/v1/extensions with the resolved manifest.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, ilike, and, ne } from '@plexo/db'
import { extensionRegistry } from '@plexo/db'
import { logger } from '../logger.js'
import { validateManifest } from '@joeybuilt/plexo-sdk'
import type { ExtensionManifest } from '@joeybuilt/plexo-sdk'
import { createHash } from 'node:crypto'
import { requireAuth } from '../middleware/auth.js'

export const registryRouter: RouterType = Router()

// ── GET /api/v1/registry ──────────────────────────────────────────────────────

registryRouter.get('/', async (req, res) => {
    try {
        const { q, tag, publisher, page = '1', limit = '20' } = req.query as Record<string, string>

        const pageNum = Math.max(1, parseInt(page, 10) || 1)
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
        const offset = (pageNum - 1) * limitNum

        const conditions = [
            eq(extensionRegistry.deprecated, false),
            ...(q ? [ilike(extensionRegistry.name, `%${q}%`)] : []),
            ...(publisher ? [eq(extensionRegistry.publisher, publisher)] : []),
        ]

        const rows = await db
            .select({
                name: extensionRegistry.name,
                displayName: extensionRegistry.displayName,
                description: extensionRegistry.description,
                publisher: extensionRegistry.publisher,
                latestVersion: extensionRegistry.latestVersion,
                tags: extensionRegistry.tags,
                installCount: extensionRegistry.installCount,
                publishedAt: extensionRegistry.publishedAt,
                updatedAt: extensionRegistry.updatedAt,
            })
            .from(extensionRegistry)
            .where(and(...conditions))
            .limit(limitNum)
            .offset(offset)

        // Filter by tag in-process (array column — Drizzle doesn't support array contains natively)
        const filtered = tag
            ? rows.filter((r) => r.tags.includes(tag))
            : rows

        res.json({
            data: filtered,
            pagination: { page: pageNum, limit: limitNum, returned: filtered.length },
        })
    } catch (err) {
        logger.error({ err }, 'GET /registry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Registry search failed' } })
    }
})

// ── GET /api/v1/registry/:name ────────────────────────────────────────────────

registryRouter.get('/:name', async (req, res) => {
    try {
        const name = decodeURIComponent(String(req.params.name ?? ''))

        const [entry] = await db
            .select()
            .from(extensionRegistry)
            .where(eq(extensionRegistry.name, name))
            .limit(1)

        if (!entry) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: `Tool "${name}" not found in registry` } })
            return
        }

        res.json({ data: entry })
    } catch (err) {
        logger.error({ err }, 'GET /registry/:name failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Registry lookup failed' } })
    }
})

// ── POST /api/v1/registry — Publish ──────────────────────────────────────────

registryRouter.post('/', requireAuth, async (req, res) => {
    try {
        const userId = req.user?.id
        if (!userId) {
            res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to publish tools' } })
            return
        }

        const body = req.body as {
            manifest: ExtensionManifest
            displayName?: string
            tags?: string[]
            repositoryUrl?: string
            checksum?: string
            // §Q1/§Q2 — optional package signature fields. When absent, the
            // row is stored unsigned and the install dialog downgrades the
            // effective trust tier to `community`.
            signature?: string
            signatureType?: 'sigstore' | 'ecdsa-p256'
            signerIdentity?: string
            signedAt?: string
        }

        // Validate the manifest before accepting
        const validation = validateManifest(body.manifest)
        if (!validation.valid) {
            res.status(422).json({
                error: {
                    code: 'INVALID_MANIFEST',
                    message: 'Tool manifest failed validation',
                    details: validation.errors,
                },
            })
            return
        }

        const manifest = body.manifest
        const name = manifest.name
        const version = manifest.version

        // Generate checksum from stringified manifest if not provided
        const checksum = body.checksum ??
            createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

        // §Q1/§Q2 — verify the signature metadata is well-formed before we
        // persist it. This does NOT perform real cosign verification (see
        // packages/sdk/src/validation/signature.ts for the v1 stub). It just
        // refuses partial rows (e.g. a signature without an identity).
        const signaturePayload = body.signature?.trim() ?? null
        const signatureType = body.signatureType ?? null
        const signerIdentity = body.signerIdentity?.trim() ?? null
        const signedAtRaw = body.signedAt?.trim()
        if (signaturePayload || signatureType || signerIdentity || signedAtRaw) {
            if (!signaturePayload || !signatureType || !signerIdentity) {
                res.status(422).json({
                    error: {
                        code: 'INCOMPLETE_SIGNATURE',
                        message: 'signature, signatureType, and signerIdentity must all be provided together',
                    },
                })
                return
            }
            if (signatureType !== 'sigstore' && signatureType !== 'ecdsa-p256') {
                res.status(422).json({
                    error: {
                        code: 'INVALID_SIGNATURE_TYPE',
                        message: 'signatureType must be "sigstore" or "ecdsa-p256"',
                    },
                })
                return
            }
        }
        const signedAt = signedAtRaw ? new Date(signedAtRaw) : null

        const existing = await db
            .select({ id: extensionRegistry.id, versions: extensionRegistry.versions, publisher: extensionRegistry.publisher })
            .from(extensionRegistry)
            .where(eq(extensionRegistry.name, name))
            .limit(1)

        if (existing.length > 0) {
            const record = existing[0]!
            // Verify publisher ownership — only the original publisher may update this tool
            if (record.publisher !== userId) {
                res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the original publisher may update this tool' } })
                return
            }

            const versions = record.versions ?? []
            if (!versions.includes(version)) versions.unshift(version)

            await db
                .update(extensionRegistry)
                .set({
                    latestVersion: version,
                    versions,
                    manifest,
                    displayName: body.displayName ?? manifest.name,
                    description: (manifest as unknown as Record<string, unknown>).description as string ?? '',
                    tags: body.tags ?? [],
                    repositoryUrl: body.repositoryUrl ?? null,
                    checksum,
                    signature: signaturePayload,
                    signatureType,
                    signerIdentity,
                    signedAt,
                    updatedAt: new Date(),
                })
                .where(eq(extensionRegistry.id, record.id))

            logger.info({ name, version, publisher: userId }, 'Registry tool updated')
            res.status(200).json({ ok: true, action: 'updated', name, version })
        } else {
            await db.insert(extensionRegistry).values({
                name,
                displayName: body.displayName ?? name,
                description: (manifest as unknown as Record<string, unknown>).description as string ?? '',
                publisher: userId,
                latestVersion: version,
                versions: [version],
                manifest,
                tags: body.tags ?? [],
                repositoryUrl: body.repositoryUrl ?? null,
                checksum,
                signature: signaturePayload,
                signatureType,
                signerIdentity,
                signedAt,
            })

            logger.info({ name, version, publisher: userId }, 'Registry tool published')
            res.status(201).json({ ok: true, action: 'published', name, version })
        }
    } catch (err) {
        logger.error({ err }, 'POST /registry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Publish failed' } })
    }
})

// ── DELETE /api/v1/registry/:name — Deprecate ────────────────────────────────

registryRouter.delete('/:name', requireAuth, async (req, res) => {
    try {
        const userId = req.user?.id
        if (!userId) {
            res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to deprecate tools' } })
            return
        }

        const name = decodeURIComponent(String(req.params.name ?? ''))

        const [entry] = await db
            .select({ id: extensionRegistry.id, publisher: extensionRegistry.publisher })
            .from(extensionRegistry)
            .where(and(eq(extensionRegistry.name, name), ne(extensionRegistry.deprecated, true)))
            .limit(1)

        if (!entry) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool not found or already deprecated' } })
            return
        }

        if (entry.publisher !== userId) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the publisher may deprecate this tool' } })
            return
        }

        await db
            .update(extensionRegistry)
            .set({ deprecated: true, updatedAt: new Date() })
            .where(eq(extensionRegistry.id, entry.id))

        logger.info({ name, userId: userId }, 'Registry tool deprecated')
        res.json({ ok: true, deprecated: true, name })
    } catch (err) {
        logger.error({ err }, 'DELETE /registry/:name failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Deprecate failed' } })
    }
})
