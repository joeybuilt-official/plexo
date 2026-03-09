// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Extension Registry API (§12)
 *
 * Public discovery and publishing of Kapsel extensions.
 *
 * GET    /api/v1/registry                Search/list extensions
 * GET    /api/v1/registry/:name          Get extension details (URL-encoded scoped name)
 * POST   /api/v1/registry                Publish/update an extension (auth required)
 * DELETE /api/v1/registry/:name          Deprecate an extension (auth required)
 *
 * Install flow: calls GET /registry/:name to get the manifest,
 * then POST /api/v1/plugins with the resolved kapsel.json.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, ilike, and, ne } from '@plexo/db'
import { kapselRegistry } from '@plexo/db'
import { logger } from '../logger.js'
import { validateManifest } from '@plexo/sdk'
import type { KapselManifest } from '@plexo/sdk'
import { createHash } from 'node:crypto'

export const registryRouter: RouterType = Router()

// ── GET /api/v1/registry ──────────────────────────────────────────────────────

registryRouter.get('/', async (req, res) => {
    try {
        const { q, tag, publisher, page = '1', limit = '20' } = req.query as Record<string, string>

        const pageNum = Math.max(1, parseInt(page, 10) || 1)
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
        const offset = (pageNum - 1) * limitNum

        const conditions = [
            eq(kapselRegistry.deprecated, false),
            ...(q ? [ilike(kapselRegistry.name, `%${q}%`)] : []),
            ...(publisher ? [eq(kapselRegistry.publisher, publisher)] : []),
        ]

        const rows = await db
            .select({
                name: kapselRegistry.name,
                displayName: kapselRegistry.displayName,
                description: kapselRegistry.description,
                publisher: kapselRegistry.publisher,
                latestVersion: kapselRegistry.latestVersion,
                tags: kapselRegistry.tags,
                installCount: kapselRegistry.installCount,
                publishedAt: kapselRegistry.publishedAt,
                updatedAt: kapselRegistry.updatedAt,
            })
            .from(kapselRegistry)
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
        const name = decodeURIComponent(req.params.name)

        const [entry] = await db
            .select()
            .from(kapselRegistry)
            .where(eq(kapselRegistry.name, name))
            .limit(1)

        if (!entry) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: `Extension "${name}" not found in registry` } })
            return
        }

        res.json({ data: entry })
    } catch (err) {
        logger.error({ err }, 'GET /registry/:name failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Registry lookup failed' } })
    }
})

// ── POST /api/v1/registry — Publish ──────────────────────────────────────────

registryRouter.post('/', async (req, res) => {
    try {
        // Auth: require a session (workspace member or API token)
        const userId = req.headers['x-user-id'] as string | undefined
        if (!userId) {
            res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to publish extensions' } })
            return
        }

        const body = req.body as {
            manifest: KapselManifest
            displayName?: string
            tags?: string[]
            repositoryUrl?: string
            checksum?: string
        }

        // Validate the manifest before accepting
        const validation = validateManifest(body.manifest)
        if (!validation.valid) {
            res.status(422).json({
                error: {
                    code: 'INVALID_MANIFEST',
                    message: 'kapsel.json failed validation',
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

        const existing = await db
            .select({ id: kapselRegistry.id, versions: kapselRegistry.versions, publisher: kapselRegistry.publisher })
            .from(kapselRegistry)
            .where(eq(kapselRegistry.name, name))
            .limit(1)

        if (existing.length > 0) {
            const record = existing[0]!
            // Verify publisher ownership — only the original publisher may update
            if (record.publisher !== userId) {
                res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the original publisher may update this extension' } })
                return
            }

            const versions = record.versions ?? []
            if (!versions.includes(version)) versions.unshift(version)

            await db
                .update(kapselRegistry)
                .set({
                    latestVersion: version,
                    versions,
                    manifest,
                    displayName: body.displayName ?? manifest.name,
                    description: (manifest as unknown as Record<string, unknown>).description as string ?? '',
                    tags: body.tags ?? [],
                    repositoryUrl: body.repositoryUrl ?? null,
                    checksum,
                    updatedAt: new Date(),
                })
                .where(eq(kapselRegistry.id, record.id))

            logger.info({ name, version, publisher: userId }, 'Registry extension updated')
            res.status(200).json({ ok: true, action: 'updated', name, version })
        } else {
            await db.insert(kapselRegistry).values({
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
            })

            logger.info({ name, version, publisher: userId }, 'Registry extension published')
            res.status(201).json({ ok: true, action: 'published', name, version })
        }
    } catch (err) {
        logger.error({ err }, 'POST /registry failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Publish failed' } })
    }
})

// ── DELETE /api/v1/registry/:name — Deprecate ────────────────────────────────

registryRouter.delete('/:name', async (req, res) => {
    try {
        const userId = req.headers['x-user-id'] as string | undefined
        if (!userId) {
            res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to deprecate extensions' } })
            return
        }

        const name = decodeURIComponent(req.params.name)

        const [entry] = await db
            .select({ id: kapselRegistry.id, publisher: kapselRegistry.publisher })
            .from(kapselRegistry)
            .where(and(eq(kapselRegistry.name, name), ne(kapselRegistry.deprecated, true)))
            .limit(1)

        if (!entry) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extension not found or already deprecated' } })
            return
        }

        if (entry.publisher !== userId) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Only the publisher may deprecate this extension' } })
            return
        }

        await db
            .update(kapselRegistry)
            .set({ deprecated: true, updatedAt: new Date() })
            .where(eq(kapselRegistry.id, entry.id))

        logger.info({ name, userId: userId }, 'Registry extension deprecated')
        res.json({ ok: true, deprecated: true, name })
    } catch (err) {
        logger.error({ err }, 'DELETE /registry/:name failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Deprecate failed' } })
    }
})
