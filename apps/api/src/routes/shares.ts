// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import * as sharesRepo from '../repositories/shares.repository.js'
import { logger } from '../logger.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import type { Request, Response } from 'express'

// 12-char random share ID using crypto (no nanoid dep needed)
function generateShareId(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

// The share PAGE renders on the WEB app (app.getplexo.com/s/<id>), not the api
// origin (PUBLIC_URL = api.getplexo.com, whose /s/<id> 404s). Use the app origin.
const PUBLIC_URL = process.env.APP_PUBLIC_URL || process.env.BETTER_AUTH_URL || process.env.PUBLIC_URL || 'http://localhost:3000'

// ── Authenticated routes (POST/DELETE/GET on /shares/:artifactId) ───────

export const sharesRouter: RouterType = Router()

/** Look up an artifact's workspace and verify caller access. */
async function ensureArtifactWorkspaceAccess(req: Request, res: Response, artifactId: string): Promise<string | null> {
    const workspaceId = await sharesRepo.getArtifactWorkspaceId(artifactId)
    if (!workspaceId) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Artifact not found' } })
        return null
    }
    const ok = await ensureWorkspaceAccess(req, res, workspaceId)
    return ok ? workspaceId : null
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
        const existingId = await sharesRepo.getActiveShareIdByArtifact(artifactId)

        if (existingId) {
            res.json({ shareId: existingId, url: `${PUBLIC_URL}/s/${existingId}` })
            return
        }

        const shareId = generateShareId()
        await sharesRepo.createShare({
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

        await sharesRepo.revokeShareByArtifact(artifactId)

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

        const share = await sharesRepo.getActiveShareByArtifact(artifactId)

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
        const share = await sharesRepo.getActiveShareById(shareId)

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
        void sharesRepo.incrementViewCount(shareId)
            .catch((err: unknown) => logger.debug({ err, shareId }, 'view count increment failed'))

        // Fetch artifact
        const artifact = await sharesRepo.getArtifactById(share.artifactId)

        if (!artifact) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Artifact no longer exists' } })
            return
        }

        // Fetch version content
        const version = share.versionPin
            ? await sharesRepo.getPinnedVersion(share.artifactId, share.versionPin)
            : await sharesRepo.getLatestVersion(share.artifactId)

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
