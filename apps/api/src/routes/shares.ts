// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { db, eq, and, sql, isNull, desc } from '@plexo/db'
import { artifacts, artifactVersions, artifactShares } from '@plexo/db'
import { logger } from '../logger.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import type { Request, Response } from 'express'

// 12-char random share ID using crypto (no nanoid dep needed)
function generateShareId(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

const PUBLIC_URL = process.env.PUBLIC_URL || 'http://localhost:3000'

// ── Authenticated routes (POST/DELETE/GET on /shares/:artifactId) ───────

export const sharesRouter: RouterType = Router()

/** Look up an artifact's workspace and verify caller access. */
async function ensureArtifactWorkspaceAccess(req: Request, res: Response, artifactId: string): Promise<string | null> {
    const [row] = await db.select({ workspaceId: artifacts.workspaceId })
        .from(artifacts).where(eq(artifacts.id, artifactId)).limit(1)
    if (!row) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Artifact not found' } })
        return null
    }
    const ok = await ensureWorkspaceAccess(req, res, row.workspaceId)
    return ok ? row.workspaceId : null
}

// POST /api/v1/shares/:artifactId — create share link
sharesRouter.post('/:artifactId', async (req: Request, res: Response) => {
    try {
        const artifactId = req.params.artifactId as string
        const workspaceId = await ensureArtifactWorkspaceAccess(req, res, artifactId)
        if (!workspaceId) return

        const { versionPin, expiresAt } = req.body as { versionPin?: number; expiresAt?: string }

        if (expiresAt !== undefined && expiresAt !== null) {
            const expDate = new Date(expiresAt)
            if (isNaN(expDate.getTime()) || expDate <= new Date()) {
                res.status(400).json({ error: { code: 'INVALID_EXPIRES_AT', message: 'expiresAt must be a valid future date' } })
                return
            }
        }

        // Check for existing active share
        const [existing] = await db.select({ id: artifactShares.id })
            .from(artifactShares)
            .where(and(
                eq(artifactShares.artifactId, artifactId),
                isNull(artifactShares.revokedAt),
            ))
            .limit(1)

        if (existing) {
            res.json({ shareId: existing.id, url: `${PUBLIC_URL}/s/${existing.id}` })
            return
        }

        const shareId = generateShareId()
        await db.insert(artifactShares).values({
            id: shareId,
            artifactId,
            workspaceId,
            createdBy: req.user!.id,
            versionPin: versionPin ?? null,
            expiresAt: expiresAt ? new Date(expiresAt) : null,
        })

        res.status(201).json({ shareId, url: `${PUBLIC_URL}/s/${shareId}` })
    } catch (err) {
        logger.error({ err }, 'Failed to create share link')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create share link' } })
    }
})

// DELETE /api/v1/shares/:artifactId — revoke share (soft delete)
sharesRouter.delete('/:artifactId', async (req: Request, res: Response) => {
    try {
        const artifactId = req.params.artifactId as string
        const workspaceId = await ensureArtifactWorkspaceAccess(req, res, artifactId)
        if (!workspaceId) return

        const result = await db.update(artifactShares)
            .set({ revokedAt: new Date() })
            .where(and(
                eq(artifactShares.artifactId, artifactId),
                isNull(artifactShares.revokedAt),
            ))

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'Failed to revoke share link')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke share' } })
    }
})

// GET /api/v1/shares/:artifactId — get active share info (requires auth)
sharesRouter.get('/:artifactId', async (req: Request, res: Response) => {
    try {
        const artifactId = req.params.artifactId as string
        const workspaceId = await ensureArtifactWorkspaceAccess(req, res, artifactId)
        if (!workspaceId) return

        const [share] = await db.select()
            .from(artifactShares)
            .where(and(
                eq(artifactShares.artifactId, artifactId),
                isNull(artifactShares.revokedAt),
            ))
            .limit(1)

        if (!share) {
            res.json({ share: null })
            return
        }

        res.json({
            share: {
                id: share.id,
                url: `${PUBLIC_URL}/s/${share.id}`,
                viewCount: share.viewCount,
                createdAt: share.createdAt,
                expiresAt: share.expiresAt,
                versionPin: share.versionPin,
            },
        })
    } catch (err) {
        logger.error({ err }, 'Failed to get share info')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get share info' } })
    }
})

// ── Public route (GET /s/:shareId — no auth required) ───────────────────

export const publicShareRouter: RouterType = Router()

publicShareRouter.get('/:shareId', async (req: Request, res: Response) => {
    try {
        const shareId = req.params.shareId as string

        // Validate share ID format (12-char hex)
        if (!shareId || shareId.length < 8 || shareId.length > 24) {
            res.status(400).json({ error: { code: 'INVALID_SHARE', message: 'Invalid share ID' } })
            return
        }

        // Look up share — must be active (not revoked, not expired)
        const [share] = await db.select()
            .from(artifactShares)
            .where(and(
                eq(artifactShares.id, shareId),
                isNull(artifactShares.revokedAt),
            ))
            .limit(1)

        if (!share) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Share not found or revoked' } })
            return
        }

        // Check expiry
        if (share.expiresAt && share.expiresAt < new Date()) {
            res.status(410).json({ error: { code: 'EXPIRED', message: 'This share link has expired' } })
            return
        }

        // Increment view count (fire-and-forget)
        void db.update(artifactShares)
            .set({ viewCount: sql`${artifactShares.viewCount} + 1` })
            .where(eq(artifactShares.id, shareId))
            .catch((err: unknown) => logger.debug({ err, shareId }, 'view count increment failed'))

        // Fetch artifact
        const [artifact] = await db.select()
            .from(artifacts)
            .where(eq(artifacts.id, share.artifactId))
            .limit(1)

        if (!artifact) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Artifact no longer exists' } })
            return
        }

        // Fetch version content
        let version
        if (share.versionPin) {
            // Pinned version
            const [v] = await db.select()
                .from(artifactVersions)
                .where(and(
                    eq(artifactVersions.artifactId, share.artifactId),
                    eq(artifactVersions.version, share.versionPin),
                ))
                .limit(1)
            version = v
        } else {
            // Latest version
            const [v] = await db.select()
                .from(artifactVersions)
                .where(eq(artifactVersions.artifactId, share.artifactId))
                .orderBy(desc(artifactVersions.version))
                .limit(1)
            version = v
        }

        if (!version) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Artifact version not found' } })
            return
        }

        res.json({
            artifact: {
                filename: artifact.filename,
                kind: artifact.kind ?? artifact.type,
                content: version.content,
                version: version.version,
                meta: artifact.meta,
                createdAt: artifact.createdAt,
            },
            share: {
                createdAt: share.createdAt,
                viewCount: (share.viewCount ?? 0) + 1, // include current view
            },
        })
    } catch (err) {
        logger.error({ err }, 'Failed to fetch public share')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch share' } })
    }
})
