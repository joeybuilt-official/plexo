// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace Key Shares — cross-workspace AI provider credential sharing.
 *
 * GET    /api/v1/workspaces/:id/key-shares   — list shares (lending + borrowing)
 * POST   /api/v1/workspaces/:id/key-shares   — grant a share from this workspace
 * DELETE /api/v1/workspaces/:id/key-shares/:shareId — revoke a share
 *
 * Security: only the workspace owner/admin can create or revoke shares.
 * The source workspace's key is never copied; only a verified pointer is stored.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, and } from '@plexo/db'
import { workspaceKeyShares, workspaces } from '@plexo/db'
import { ulid } from 'ulid'
import { logger } from '../logger.js'

export const keySharesRouter: RouterType = Router({ mergeParams: true })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ULID_RE = /^[0-9A-Z]{26}$/

const VALID_PROVIDERS = ['openai', 'anthropic', 'openrouter', 'google', 'groq', 'mistral', 'deepseek', 'xai', 'ollama', 'ollama_cloud']

// ── GET /api/v1/workspaces/:id/key-shares ─────────────────────────────────────
// Returns shares where this workspace is the source (lending) or target (borrowing).

keySharesRouter.get('/', async (req, res) => {
    const { id } = req.params as { id: string }
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspace UUID required' } })
        return
    }

    try {
        // Fetch all shares where this workspace is source or target
        const lending = await db
            .select({
                id: workspaceKeyShares.id,
                providerKey: workspaceKeyShares.providerKey,
                grantedAt: workspaceKeyShares.grantedAt,
                targetWsId: workspaceKeyShares.targetWsId,
            })
            .from(workspaceKeyShares)
            .where(eq(workspaceKeyShares.sourceWsId, id))

        const borrowing = await db
            .select({
                id: workspaceKeyShares.id,
                providerKey: workspaceKeyShares.providerKey,
                grantedAt: workspaceKeyShares.grantedAt,
                sourceWsId: workspaceKeyShares.sourceWsId,
            })
            .from(workspaceKeyShares)
            .where(eq(workspaceKeyShares.targetWsId, id))

        // Enrich with workspace names
        const wsIds = [
            ...new Set([
                ...lending.map(r => r.targetWsId),
                ...borrowing.map(r => r.sourceWsId),
            ])
        ]

        const wsRows = wsIds.length
            ? await db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces)
                .then(rows => rows.filter(r => wsIds.includes(r.id)))
            : []

        const wsMap = Object.fromEntries(wsRows.map(r => [r.id, r.name]))

        res.json({
            lending: lending.map(r => ({
                id: r.id,
                providerKey: r.providerKey,
                grantedAt: r.grantedAt,
                targetWorkspace: { id: r.targetWsId, name: wsMap[r.targetWsId] ?? r.targetWsId },
            })),
            borrowing: borrowing.map(r => ({
                id: r.id,
                providerKey: r.providerKey,
                grantedAt: r.grantedAt,
                sourceWorkspace: { id: r.sourceWsId, name: wsMap[r.sourceWsId] ?? r.sourceWsId },
            })),
        })
    } catch (err) {
        logger.error({ err, id }, 'GET key-shares failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load key shares' } })
    }
})

// ── POST /api/v1/workspaces/:id/key-shares ────────────────────────────────────
// Grant a share: workspace :id lends providerKey to targetWorkspaceId.
// Body: { targetWorkspaceId: string, providerKey: string }

keySharesRouter.post('/', async (req, res) => {
    const { id: sourceWsId } = req.params as { id: string }
    if (!UUID_RE.test(sourceWsId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspace UUID required' } })
        return
    }

    const { targetWorkspaceId, providerKey } = req.body as { targetWorkspaceId?: string; providerKey?: string }

    if (!targetWorkspaceId || !UUID_RE.test(targetWorkspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_TARGET', message: 'Valid target workspace UUID required' } })
        return
    }
    if (targetWorkspaceId === sourceWsId) {
        res.status(400).json({ error: { code: 'SELF_SHARE', message: 'Cannot share a key with the same workspace' } })
        return
    }
    if (!providerKey || !VALID_PROVIDERS.includes(providerKey)) {
        res.status(400).json({ error: { code: 'INVALID_PROVIDER', message: `providerKey must be one of: ${VALID_PROVIDERS.join(', ')}` } })
        return
    }

    try {
        // Verify source workspace exists
        const [srcWs] = await db.select({ id: workspaces.id, ownerId: workspaces.ownerId })
            .from(workspaces).where(eq(workspaces.id, sourceWsId)).limit(1)
        if (!srcWs) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source workspace not found' } })
            return
        }

        // Verify target workspace exists
        const [tgtWs] = await db.select({ id: workspaces.id, name: workspaces.name, ownerId: workspaces.ownerId })
            .from(workspaces).where(eq(workspaces.id, targetWorkspaceId)).limit(1)
        if (!tgtWs) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Target workspace not found' } })
            return
        }

        // Phase 1: only allow sharing to workspaces owned by the same user
        if (tgtWs.ownerId !== srcWs.ownerId) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Can only share keys with your own workspaces (cross-user sharing not yet supported)' } })
            return
        }

        const shareId = ulid()
        await db.insert(workspaceKeyShares).values({
            id: shareId,
            sourceWsId,
            targetWsId: targetWorkspaceId,
            providerKey,
            grantedBy: srcWs.ownerId,  // using owner as granting user (Phase 1; Phase 2 uses session user)
        }).onConflictDoNothing()

        // Update the target workspace's aiProviders settings to add the keySource reference.
        // Also copy non-sensitive config (baseUrl, selectedModel, dynamicModels) from the
        // source so the borrowing workspace shows the correct URL and ensemble info.
        const [[tgtWsSettings], [srcWsSettings]] = await Promise.all([
            db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, targetWorkspaceId)).limit(1),
            db.select({ settings: workspaces.settings, name: workspaces.name }).from(workspaces).where(eq(workspaces.id, sourceWsId)).limit(1),
        ])

        if (tgtWsSettings) {
            const settings = (tgtWsSettings.settings ?? {}) as Record<string, unknown>
            const aiProviders = (settings.aiProviders ?? {}) as Record<string, unknown>
            const providers = (aiProviders.providers ?? {}) as Record<string, unknown>

            // Pull safe (non-secret) fields from source provider config
            const srcAiProviders = ((srcWsSettings?.settings as Record<string, unknown> | undefined)?.aiProviders ?? {}) as Record<string, unknown>
            const srcProviders = (srcAiProviders.providers ?? {}) as Record<string, Record<string, unknown>>
            const srcEntry = srcProviders[providerKey] ?? {}

            providers[providerKey] = {
                ...(providers[providerKey] as Record<string, unknown> ?? {}),
                // Copy display-safe config from source
                ...(srcEntry.baseUrl ? { baseUrl: srcEntry.baseUrl } : {}),
                ...(srcEntry.selectedModel ? { selectedModel: srcEntry.selectedModel } : {}),
                ...(Array.isArray(srcEntry.dynamicModels) && (srcEntry.dynamicModels as unknown[]).length > 0 ? { dynamicModels: srcEntry.dynamicModels } : {}),
                status: 'borrowed',
                keySource: { workspaceId: sourceWsId, workspaceName: srcWsSettings?.name ?? sourceWsId },
            }

            await db.update(workspaces).set({
                settings: { ...settings, aiProviders: { ...aiProviders, providers } },
            }).where(eq(workspaces.id, targetWorkspaceId))
        }

        logger.info({ sourceWsId, targetWorkspaceId, providerKey, shareId }, 'key-share: created')
        res.status(201).json({ ok: true, shareId, targetWorkspace: { id: tgtWs.id, name: tgtWs.name } })
    } catch (err) {
        logger.error({ err, sourceWsId, targetWorkspaceId, providerKey }, 'POST key-shares failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create key share' } })
    }
})

// ── DELETE /api/v1/workspaces/:id/key-shares/:shareId ─────────────────────────
// Revoke a share. Removes the row and clears keySource from the target workspace.

keySharesRouter.delete('/:shareId', async (req, res) => {
    const { id: sourceWsId, shareId } = req.params as { id: string; shareId: string }

    if (!UUID_RE.test(sourceWsId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspace UUID required' } })
        return
    }
    if (!ULID_RE.test(shareId.toUpperCase())) {
        res.status(400).json({ error: { code: 'INVALID_SHARE_ID', message: 'Valid share ID required' } })
        return
    }

    try {
        // Fetch the share to know the target and provider before deleting
        const [share] = await db.select()
            .from(workspaceKeyShares)
            .where(and(
                eq(workspaceKeyShares.id, shareId.toUpperCase()),
                eq(workspaceKeyShares.sourceWsId, sourceWsId),
            ))
            .limit(1)

        if (!share) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Share not found or not owned by this workspace' } })
            return
        }

        // Delete the share row
        await db.delete(workspaceKeyShares)
            .where(eq(workspaceKeyShares.id, share.id))

        // Clear keySource from the target workspace's settings
        const [tgtWsSettings] = await db.select({ settings: workspaces.settings })
            .from(workspaces).where(eq(workspaces.id, share.targetWsId)).limit(1)

        if (tgtWsSettings) {
            const settings = (tgtWsSettings.settings ?? {}) as Record<string, unknown>
            const aiProviders = (settings.aiProviders ?? {}) as Record<string, unknown>
            const providers = (aiProviders.providers ?? {}) as Record<string, unknown>

            if (providers[share.providerKey]) {
                const providerEntry = { ...(providers[share.providerKey] as Record<string, unknown>) }
                delete providerEntry.keySource
                providerEntry.status = 'unconfigured'
                providers[share.providerKey] = providerEntry
            }

            await db.update(workspaces).set({
                settings: { ...settings, aiProviders: { ...aiProviders, providers } },
            }).where(eq(workspaces.id, share.targetWsId))
        }

        logger.info({ shareId, sourceWsId, targetWsId: share.targetWsId, providerKey: share.providerKey }, 'key-share: revoked')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, shareId, sourceWsId }, 'DELETE key-share failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to revoke key share' } })
    }
})
