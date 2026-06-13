// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Hub Catalog API — in-app Hub browsing.
 *
 * GET /api/v1/hub/catalog?workspaceId=...&type=...&q=...&sort=...
 *
 * Returns the full set of published extension_registry items joined with
 * the installation status for the given workspace, plus vote counts and
 * (if authenticated) the caller's own vote. This is what the in-app Hub
 * page renders — the public hub.getplexo.com site continues to hit the
 * @plexo/hub package directly.
 *
 * POST /api/v1/hub/extensions/:extensionId/vote  — upsert/remove caller's vote
 * GET  /api/v1/hub/extensions/:extensionId/votes — fetch counts + caller's vote
 *
 * Response shape:
 *   { items: HubItem[] }
 *
 * HubItem:
 *   slug, name, displayName, description, type, version, manifest, trust,
 *   publisher, installCount, updatedAt, iconUrl, category, tags,
 *   sourceUrl, sourceAuthor, sourceLicense, sourceRepo,
 *   upvotes, downvotes, score, userVote,
 *   installStatus: 'installed' | 'not_installed' | 'coming_soon' | 'incompatible',
 *   installedExtensionId?: string,
 *   enabled?: boolean
 */

import { Router, type Router as RouterType } from 'express'
import * as hubRepo from '../repositories/hub.repository.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'

export const hubRouter: RouterType = Router()

// ── Types ────────────────────────────────────────────────────────────────────

interface HubItem {
    slug: string
    name: string
    displayName: string
    description: string
    type: string
    version: string
    manifest: unknown
    trust: 'verified' | 'community'
    publisher: string
    installCount: number
    updatedAt: string
    iconUrl: string | null
    category: string
    tags: string[]
    sourceUrl: string | null
    sourceAuthor: string | null
    sourceLicense: string | null
    sourceRepo: string | null
    upvotes: number
    downvotes: number
    score: number
    userVote: 'up' | 'down' | null
    installStatus: 'installed' | 'not_installed' | 'coming_soon' | 'incompatible'
    installedExtensionId?: string
    enabled?: boolean
}

function manifestField<T = unknown>(manifest: unknown, key: string): T | undefined {
    if (!manifest || typeof manifest !== 'object') return undefined
    return (manifest as Record<string, unknown>)[key] as T | undefined
}

function deriveTrust(manifest: unknown, publisher: string): 'verified' | 'community' {
    const explicit = manifestField<string>(manifest, 'trust')
    if (explicit === 'verified' || explicit === 'official') return 'verified'
    if (publisher === '@plexo' || publisher === 'plexo' || publisher.startsWith('@plexo/')) return 'verified'
    if (publisher === '@joeybuilt' || publisher === 'joeybuilt' || publisher.startsWith('@joeybuilt/')) return 'verified'
    return 'community'
}

function deriveType(manifest: unknown, fallback = 'tool'): string {
    const t = manifestField<string>(manifest, 'type')
    return typeof t === 'string' && t.length > 0 ? t : fallback
}

async function loadVoteCounts(): Promise<Map<string, { upvotes: number; downvotes: number; score: number }>> {
    const list = await hubRepo.getAllVoteCounts()
    const m = new Map<string, { upvotes: number; downvotes: number; score: number }>()
    for (const r of list) {
        m.set(r.extension_id, {
            upvotes: Number(r.upvotes) || 0,
            downvotes: Number(r.downvotes) || 0,
            score: Number(r.score) || 0,
        })
    }
    return m
}

async function loadUserVotes(userId: string): Promise<Map<string, 'up' | 'down'>> {
    const rows = await hubRepo.getUserVotes(userId)
    const m = new Map<string, 'up' | 'down'>()
    for (const r of rows) {
        if (r.voteType === 'up' || r.voteType === 'down') m.set(r.extensionId, r.voteType)
    }
    return m
}

async function voteSummary(extensionId: string, userId: string | null): Promise<{
    upvotes: number
    downvotes: number
    score: number
    userVote: 'up' | 'down' | null
}> {
    const list = await hubRepo.getVoteCountsForExtension(extensionId)
    const row = list[0]
    const upvotes = row ? Number(row.upvotes) || 0 : 0
    const downvotes = row ? Number(row.downvotes) || 0 : 0
    const score = row ? Number(row.score) || 0 : 0

    let userVote: 'up' | 'down' | null = null
    if (userId) {
        const uv = await hubRepo.getUserVoteForExtension(userId, extensionId)
        const vt = uv[0]?.voteType
        if (vt === 'up' || vt === 'down') userVote = vt
    }

    return { upvotes, downvotes, score, userVote }
}

// ── GET /api/v1/hub/catalog ──────────────────────────────────────────────────

hubRouter.get('/catalog', async (req, res) => {
    const { workspaceId, type, q, sort } = req.query as {
        workspaceId?: string
        type?: string
        q?: string
        sort?: string
    }
    const limit = Math.min(parseInt((req.query.limit as string | undefined) ?? '200', 10), 500)
    const offset = Math.max(parseInt((req.query.offset as string | undefined) ?? '0', 10), 0)

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    if (q && q.length > 200) {
        res.status(400).json({ error: { code: 'QUERY_TOO_LONG', message: 'q must be 200 chars or fewer' } })
        return
    }

    try {
        // Pull full registry rows — the catalog is small (tens/hundreds of entries);
        // filtering and sorting happen in-process for correctness against manifest JSON.
        const rows = await hubRepo.listRegistry({ type, q })

        // Fetch installed items for this workspace to determine install status.
        const installed = await hubRepo.listInstalled(workspaceId)

        const installedByName = new Map<string, { id: string; enabled: boolean }>()
        for (const inst of installed) {
            installedByName.set(inst.name, { id: inst.id, enabled: inst.enabled })
        }

        // Vote enrichment.
        const voteCounts = await loadVoteCounts()
        const userId = req.user?.id ?? null
        const userVotes = userId ? await loadUserVotes(userId) : new Map<string, 'up' | 'down'>()

        const items: HubItem[] = rows.map((row) => {
            const entry = manifestField<string>(row.manifest, 'entry')
            const itemType = deriveType(row.manifest)
            const inst = installedByName.get(row.name)

            let installStatus: HubItem['installStatus']
            if (inst) installStatus = 'installed'
            else if (!entry || (typeof entry === 'string' && entry.length === 0)) installStatus = 'coming_soon'
            else installStatus = 'not_installed'

            const counts = voteCounts.get(row.name) ?? { upvotes: 0, downvotes: 0, score: 0 }
            const userVote = userVotes.get(row.name) ?? null

            return {
                slug: row.name,
                name: row.name,
                displayName: row.displayName,
                description: row.description,
                type: itemType,
                version: row.latestVersion,
                manifest: row.manifest,
                trust: deriveTrust(row.manifest, row.publisher),
                publisher: row.publisher,
                installCount: row.installCount,
                updatedAt: row.updatedAt.toISOString(),
                iconUrl: row.iconUrl ?? null,
                category: row.category,
                tags: row.tags,
                sourceUrl: row.sourceUrl ?? null,
                sourceAuthor: row.sourceAuthor ?? null,
                sourceLicense: row.sourceLicense ?? null,
                sourceRepo: row.sourceRepo ?? null,
                upvotes: counts.upvotes,
                downvotes: counts.downvotes,
                score: counts.score,
                userVote,
                installStatus,
                installedExtensionId: inst?.id,
                enabled: inst?.enabled,
            }
        })

        // Sorting: default is score DESC, name ASC. Alternatives:
        //   ?sort=newest   → updatedAt desc
        //   ?sort=popular  → upvotes + downvotes desc (most engagement)
        //   ?sort=score    → explicit score desc (default)
        const sortMode = sort || 'score'
        if (sortMode === 'newest') {
            items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        } else if (sortMode === 'popular') {
            items.sort((a, b) => {
                const d = (b.upvotes + b.downvotes) - (a.upvotes + a.downvotes)
                if (d !== 0) return d
                return a.displayName.localeCompare(b.displayName)
            })
        } else {
            items.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score
                return a.displayName.localeCompare(b.displayName)
            })
        }

        const total = items.length
        const paginated = items.slice(offset, offset + limit)
        res.json({ items: paginated, total, limit, offset })
    } catch (err) {
        logger.error({ err }, 'GET /hub/catalog failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Hub catalog lookup failed' } })
    }
})

// ── GET /api/v1/hub/extensions/:extensionId/votes ───────────────────────────

hubRouter.get('/extensions/:extensionId/votes', async (req, res) => {
    const extensionId = req.params.extensionId
    if (!extensionId) {
        res.status(400).json({ error: { code: 'MISSING_EXTENSION', message: 'extensionId required' } })
        return
    }
    try {
        const userId = req.user?.id ?? null
        const summary = await voteSummary(extensionId, userId)
        res.json(summary)
    } catch (err) {
        logger.error({ err, extensionId }, 'GET /hub/extensions/:extensionId/votes failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Vote lookup failed' } })
    }
})

// ── POST /api/v1/hub/extensions/:extensionId/vote ───────────────────────────

hubRouter.post('/extensions/:extensionId/vote', async (req, res) => {
    const extensionId = req.params.extensionId
    if (!extensionId) {
        res.status(400).json({ error: { code: 'MISSING_EXTENSION', message: 'extensionId required' } })
        return
    }
    const userId = req.user?.id
    if (!userId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Login required to vote' } })
        return
    }

    const body = (req.body ?? {}) as { voteType?: 'up' | 'down' | null }
    const voteType = body.voteType
    if (voteType !== 'up' && voteType !== 'down' && voteType !== null) {
        res.status(400).json({
            error: { code: 'INVALID_VOTE', message: "voteType must be 'up', 'down', or null" },
        })
        return
    }

    try {
        // Verify the extension actually exists — prevent orphan votes.
        if (!await hubRepo.registryExists(extensionId)) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extension not found' } })
            return
        }

        if (voteType === null) {
            await hubRepo.deleteUserVote(userId, extensionId)
        } else {
            await hubRepo.upsertVote(extensionId, userId, voteType)
        }

        const summary = await voteSummary(extensionId, userId)
        res.json(summary)
    } catch (err) {
        logger.error({ err, extensionId, userId }, 'POST /hub/extensions/:extensionId/vote failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Vote update failed' } })
    }
})
