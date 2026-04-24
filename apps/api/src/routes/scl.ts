// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL API routes — Golden Record operations.
 *
 * POST /api/v1/scl/expand         — expand with stimulus + level + budget
 * POST /api/v1/scl/mutate         — submit mutation (concepts + relations)
 * GET  /api/v1/scl/record/meta    — Golden Record metadata
 * GET  /api/v1/scl/drift          — list pending DriftWarnings
 * POST /api/v1/scl/drift/:id/resolve — confirm or reject drift
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { db, sql, eq } from '@plexo/db'
import { sclDriftWarnings, workspaces } from '@plexo/db'
import { pgRows } from '../lib/pg-rows.js'
import { logger } from '../logger.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { invalidateIntelligenceSettings } from '../lib/intelligence-cache.js'

export const sclRouter: RouterType = Router()

// ── POST /boot ───────────────────────────────────────────────────────────────

sclRouter.post('/boot', async (req: Request, res: Response) => {
    const { workspaceId } = req.body as { workspaceId: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { bootWorkspaceGoldenRecord } = await import('@plexo/agent/scl/boot-workspace')
        await bootWorkspaceGoldenRecord(workspaceId)

        const { loadGoldenRecord } = await import('@plexo/agent/scl/storage')
        const record = await loadGoldenRecord(workspaceId)

        // Wire emitSclBoot analytics (domain mastery Phase 1)
        try {
            const { emitSclBoot } = await import('../analytics/events.js')
            emitSclBoot({ spiritAnchorCount: record?.attractors.filter(a => a.depthClass === 'spirit').length ?? 0 })
        } catch { /* analytics are fire-and-forget */ }

        res.json({
            ok: true,
            attractors: record?.attractors.length ?? 0,
            regions: record?.regions.length ?? 0,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL boot failed')
        res.status(500).json({ error: { code: 'BOOT_FAILED', message: (err as Error).message } })
    }
})

// ── POST /reembed ────────────────────────────────────────────────────────────

sclRouter.post('/reembed', async (req: Request, res: Response) => {
    const { workspaceId } = req.body as { workspaceId: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { reembedGoldenRecord } = await import('@plexo/agent/scl/boot-workspace')
        const result = await reembedGoldenRecord(workspaceId)
        res.json({ ok: true, ...result })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL re-embed failed')
        res.status(500).json({ error: { code: 'REEMBED_FAILED', message: (err as Error).message } })
    }
})

// ── POST /expand ─────────────────────────────────────────────────────────────

sclRouter.post('/expand', async (req: Request, res: Response) => {
    const { workspaceId, stimulus, level = 'L1', contextBudget = 2000 } = req.body as {
        workspaceId: string; stimulus: string; level?: string; contextBudget?: number
    }

    if (!workspaceId || !stimulus) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and stimulus required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { expandForTask } = await import('@plexo/agent/scl/task-expansion')
        const { resolveEmbeddingProvider } = await import('@plexo/agent/scl/embedding-provider')
        const embProvider = await resolveEmbeddingProvider(workspaceId)
        const validLevel = (['L0', 'L1', 'L2'].includes(level) ? level : 'L1') as import('@plexo/scl-core').ResolutionLevel

        const result = await expandForTask(workspaceId, stimulus, embProvider, validLevel, contextBudget)
        if (!result) {
            res.json({ expanded: false, reason: 'SCL not enabled or no Golden Record' })
            return
        }

        res.json({ expanded: true, ...result })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL expand failed')
        res.status(500).json({ error: { code: 'EXPAND_FAILED', message: 'SCL expansion failed' } })
    }
})

// ── POST /mutate ─────────────────────────────────────────────────────────────

sclRouter.post('/mutate', async (req: Request, res: Response) => {
    const { workspaceId, concepts, relations = [], source = 'api' } = req.body as {
        workspaceId: string
        concepts: Array<{ label: string; type: string }>
        relations?: Array<{ source: string; target: string; relation: string; confidence: number }>
        source?: string
    }

    if (!workspaceId || !concepts?.length) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId and concepts required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { isSclEnabled, loadGoldenRecord, saveGoldenRecord } = await import('@plexo/agent/scl/storage')
        if (!(await isSclEnabled(workspaceId))) {
            res.status(400).json({ error: { code: 'SCL_DISABLED', message: 'SCL not enabled for this workspace' } })
            return
        }

        const record = await loadGoldenRecord(workspaceId)
        if (!record) {
            res.status(404).json({ error: { code: 'NO_RECORD', message: 'No Golden Record found' } })
            return
        }

        const { mutate } = await import('@plexo/scl-core')
        const { resolveEmbeddingProvider } = await import('@plexo/agent/scl/embedding-provider')
        const embProvider = await resolveEmbeddingProvider(workspaceId)

        // Embed all concepts
        const embeddedConcepts = []
        for (const c of concepts.slice(0, 10)) {
            const position = await embProvider.embed(c.label)
            embeddedConcepts.push({ label: c.label, type: c.type as any, position })
        }

        const result = mutate(record, {
            source,
            concepts: embeddedConcepts,
            relations: (relations ?? []).map(r => ({
                sourceLabel: r.source,
                targetLabel: r.target,
                relation: r.relation as any,
                confidence: r.confidence,
            })),
        })

        await saveGoldenRecord(workspaceId, record)

        // Store drift warnings if any
        if (result.driftWarnings.length > 0) {
            await db.insert(sclDriftWarnings).values(
                result.driftWarnings.map(w => ({
                    workspaceId,
                    attractorId: w.attractorId,
                    attractorLabel: w.attractorLabel,
                    currentPosition: w.currentPosition,
                    proposedPosition: w.proposedPosition,
                    semanticDistance: w.semanticDistance,
                    threshold: w.threshold,
                    source: w.source,
                    status: 'pending',
                }))
            ).catch(() => null)
        }

        res.json({
            attractorsCreated: result.attractorsCreated,
            attractorsRefined: result.attractorsRefined,
            ghostsArchived: result.ghostsArchived.length,
            driftWarnings: result.driftWarnings.length,
            rulesAdded: result.rulesAdded,
            rulesRefined: result.rulesRefined,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL mutate failed')
        res.status(500).json({ error: { code: 'MUTATE_FAILED', message: 'SCL mutation failed' } })
    }
})

// ── GET /record/meta ─────────────────────────────────────────────────────────

sclRouter.get('/record/meta', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { loadGoldenRecord, isSclEnabled } = await import('@plexo/agent/scl/storage')
        const enabled = await isSclEnabled(workspaceId)
        if (!enabled) {
            res.json({ enabled: false })
            return
        }

        const record = await loadGoldenRecord(workspaceId)
        if (!record) {
            res.json({ enabled: true, booted: false })
            return
        }

        const spiritCount = record.attractors.filter(a => a.depthClass === 'spirit').length
        const mechanicsCount = record.attractors.filter(a => a.depthClass === 'mechanics').length

        res.json({
            enabled: true,
            booted: true,
            version: record.version,
            regionCount: record.regions.length,
            attractorCount: record.attractors.length,
            spiritCount,
            mechanicsCount,
            transformationCount: record.transformations.length,
            ledgerRefCount: record.ledgerRefs.length,
            lastMutatedAt: record.lastMutatedAt,
            bootedAt: record.bootedAt,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL record meta failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load record metadata' } })
    }
})

// ── GET /drift ───────────────────────────────────────────────────────────────

sclRouter.get('/drift', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const rows = await db.select()
            .from(sclDriftWarnings)
            .where(eq(sclDriftWarnings.workspaceId, workspaceId))
            .orderBy(sclDriftWarnings.createdAt)

        res.json({ warnings: rows })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL drift query failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load drift warnings' } })
    }
})

// ── POST /drift/:id/resolve ──────────────────────────────────────────────────

sclRouter.post('/drift/:id/resolve', async (req: Request, res: Response) => {
    const warningId = String(req.params.id)
    const { decision, workspaceId } = req.body as { decision: 'confirm' | 'reject'; workspaceId: string }

    if (!decision || !workspaceId || !['confirm', 'reject'].includes(decision)) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'decision (confirm|reject) and workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const [warning] = await db.select()
            .from(sclDriftWarnings)
            .where(eq(sclDriftWarnings.id, warningId))
            .limit(1)

        if (!warning) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Drift warning not found' } })
            return
        }

        if (warning.status !== 'pending') {
            res.status(400).json({ error: { code: 'ALREADY_RESOLVED', message: `Warning already ${warning.status}` } })
            return
        }

        // Apply to Golden Record if confirming
        if (decision === 'confirm') {
            const { loadGoldenRecord, saveGoldenRecord } = await import('@plexo/agent/scl/storage')
            const { resolveDrift } = await import('@plexo/scl-core')
            const record = await loadGoldenRecord(workspaceId)
            if (record) {
                const driftWarning = {
                    attractorId: warning.attractorId,
                    attractorLabel: warning.attractorLabel,
                    currentPosition: warning.currentPosition as number[],
                    proposedPosition: warning.proposedPosition as number[],
                    semanticDistance: warning.semanticDistance,
                    threshold: warning.threshold,
                    source: warning.source,
                    status: 'pending' as const,
                    createdAt: warning.createdAt.getTime(),
                }
                const updated = resolveDrift(record, driftWarning, 'confirm')
                await saveGoldenRecord(workspaceId, updated)
            }
        }

        // Update DB status
        await db.update(sclDriftWarnings)
            .set({ status: decision === 'confirm' ? 'confirmed' : 'rejected', resolvedAt: new Date() })
            .where(eq(sclDriftWarnings.id, warningId))

        res.json({ ok: true, status: decision === 'confirm' ? 'confirmed' : 'rejected' })
    } catch (err) {
        logger.error({ err, warningId }, 'SCL drift resolve failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to resolve drift warning' } })
    }
})

// ── GET /config ─────────────────────────────────────────────────────────────

interface SclConfig {
    spiritDriftThreshold: number
    promotionMutationCount: number
    expansionBudgetL0: number
    expansionBudgetL1: number
    expansionBudgetL2: number
    ghostDisplacementThreshold: number
}

const SCL_DEFAULTS: SclConfig = {
    spiritDriftThreshold: 0.15,
    promotionMutationCount: 5,
    expansionBudgetL0: 10,
    expansionBudgetL1: 50,
    expansionBudgetL2: 500,
    ghostDisplacementThreshold: 0.3,
}

const SCL_BOUNDS: Record<keyof SclConfig, { min: number; max: number }> = {
    spiritDriftThreshold: { min: 0.05, max: 0.5 },
    promotionMutationCount: { min: 2, max: 50 },
    expansionBudgetL0: { min: 5, max: 50 },
    expansionBudgetL1: { min: 20, max: 200 },
    expansionBudgetL2: { min: 100, max: 2000 },
    ghostDisplacementThreshold: { min: 0.1, max: 0.8 },
}

sclRouter.get('/config', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        const saved = (ws?.settings as Record<string, unknown>)?.sclConfig as Partial<SclConfig> | undefined
        res.json({ config: { ...SCL_DEFAULTS, ...saved }, defaults: SCL_DEFAULTS, bounds: SCL_BOUNDS })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL config read failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load SCL config' } })
    }
})

// ── PATCH /config ───────────────────────────────────────────────────────────

// ── Phase 3a — Intelligence-overhaul SCL settings ────────────────────────────
//
// `/settings` is the canonical home for the SCL controls surface in
// Settings → Intelligence → SCL. It persists to
// `workspaces.intelligence_settings.scl.*` (Phase 0 JSONB column) so
// it shares the cache surface with the rest of the intelligence stack.
//
// The legacy `/config` route above writes to a different shape inside
// `workspaces.settings.sclConfig` and stays for backward compatibility
// with anything that already calls it; the executor reads through
// `loadSclRuntimeSettings` which prefers the new home and falls back
// to the legacy boolean only for `enabled`.

interface SclSettingsView {
    enabled: boolean
    driftThreshold: number
    expandDepth: number
    expandWidth: number
    domainRegions: string[] | null
    piiScrubEnabled: boolean
}

const SCL_SETTINGS_DEFAULTS: SclSettingsView = {
    enabled: false,
    driftThreshold: 0.15,
    expandDepth: 1,
    expandWidth: 50,
    domainRegions: null,
    piiScrubEnabled: true,
}

const SCL_SETTINGS_BOUNDS = {
    driftThreshold: { min: 0.05, max: 0.5 },
    expandDepth: { min: 0, max: 4 },
    expandWidth: { min: 5, max: 500 },
} as const

function readSclSettings(intelligence: Record<string, unknown> | null | undefined): SclSettingsView {
    const intelligenceRecord = (intelligence ?? {}) as Record<string, unknown>
    const block = (intelligenceRecord.scl ?? {}) as Record<string, unknown>
    return {
        enabled: typeof block.enabled === 'boolean' ? block.enabled : SCL_SETTINGS_DEFAULTS.enabled,
        driftThreshold: typeof block.driftThreshold === 'number' ? block.driftThreshold : SCL_SETTINGS_DEFAULTS.driftThreshold,
        expandDepth: typeof block.expandDepth === 'number' ? block.expandDepth : SCL_SETTINGS_DEFAULTS.expandDepth,
        expandWidth: typeof block.expandWidth === 'number' ? block.expandWidth : SCL_SETTINGS_DEFAULTS.expandWidth,
        domainRegions: Array.isArray(block.domainRegions) ? (block.domainRegions as string[]) : null,
        piiScrubEnabled: typeof block.piiScrubEnabled === 'boolean' ? block.piiScrubEnabled : SCL_SETTINGS_DEFAULTS.piiScrubEnabled,
    }
}

async function invalidateAgentSclCache(workspaceId: string): Promise<void> {
    try {
        const mod = await import('@plexo/agent/scl/storage')
        mod.invalidateSclRuntimeSettings(workspaceId)
    } catch (err) {
        logger.warn({ err, workspaceId }, 'agent SCL cache invalidate failed (non-fatal)')
    }
}

// GET /api/v1/scl/settings?workspaceId=...
sclRouter.get('/settings', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const [row] = await db.select({
            settings: workspaces.settings,
            intelligenceSettings: workspaces.intelligenceSettings,
        }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)

        const intelligenceSettings = row?.intelligenceSettings as Record<string, unknown> | undefined
        const view = readSclSettings(intelligenceSettings)
        // Legacy fallback for `enabled` so a workspace migrated from Phase 0
        // sees the existing on/off state until it touches the new toggle.
        const sclBlock = intelligenceSettings?.scl as Record<string, unknown> | undefined
        if (typeof sclBlock?.enabled !== 'boolean') {
            const legacy = (row?.settings ?? {}) as Record<string, unknown>
            if (legacy.scl_enabled === true) view.enabled = true
        }
        res.json({
            settings: view,
            defaults: SCL_SETTINGS_DEFAULTS,
            bounds: SCL_SETTINGS_BOUNDS,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL settings load failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load SCL settings' } })
    }
})

// PATCH /api/v1/scl/settings
sclRouter.patch('/settings', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { workspaceId?: string } & Partial<SclSettingsView>
    const { workspaceId } = body
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // Validate. Each field is optional — only set fields are merged.
    const errors: string[] = []
    const patch: Partial<SclSettingsView> = {}

    if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') errors.push('enabled must be a boolean')
        else patch.enabled = body.enabled
    }
    if (body.driftThreshold !== undefined) {
        const n = Number(body.driftThreshold)
        const b = SCL_SETTINGS_BOUNDS.driftThreshold
        if (!Number.isFinite(n) || n < b.min || n > b.max) errors.push(`driftThreshold must be between ${b.min} and ${b.max}`)
        else patch.driftThreshold = n
    }
    if (body.expandDepth !== undefined) {
        const n = Math.round(Number(body.expandDepth))
        const b = SCL_SETTINGS_BOUNDS.expandDepth
        if (!Number.isFinite(n) || n < b.min || n > b.max) errors.push(`expandDepth must be between ${b.min} and ${b.max}`)
        else patch.expandDepth = n
    }
    if (body.expandWidth !== undefined) {
        const n = Math.round(Number(body.expandWidth))
        const b = SCL_SETTINGS_BOUNDS.expandWidth
        if (!Number.isFinite(n) || n < b.min || n > b.max) errors.push(`expandWidth must be between ${b.min} and ${b.max}`)
        else patch.expandWidth = n
    }
    if (body.domainRegions !== undefined) {
        if (body.domainRegions === null) patch.domainRegions = null
        else if (!Array.isArray(body.domainRegions) || body.domainRegions.some(v => typeof v !== 'string')) {
            errors.push('domainRegions must be null or an array of strings')
        } else {
            patch.domainRegions = body.domainRegions
        }
    }
    if (body.piiScrubEnabled !== undefined) {
        if (typeof body.piiScrubEnabled !== 'boolean') errors.push('piiScrubEnabled must be a boolean')
        else patch.piiScrubEnabled = body.piiScrubEnabled
    }

    if (errors.length > 0) {
        res.status(400).json({ error: { code: 'INVALID_SETTINGS', message: errors.join('; ') } })
        return
    }
    if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: { code: 'NO_FIELDS', message: 'no recognized fields in body' } })
        return
    }

    try {
        // Read existing scl block, merge patch in, write back. JSON-safe
        // values are stringified into the jsonb_set value.
        const [row] = await db.select({ intelligenceSettings: workspaces.intelligenceSettings })
            .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
        const settingsRecord = (row?.intelligenceSettings ?? {}) as Record<string, unknown>
        const existing = (settingsRecord.scl ?? {}) as Record<string, unknown>
        const merged = { ...existing, ...patch }

        await db.execute(sql`
            UPDATE workspaces
            SET intelligence_settings = jsonb_set(
                COALESCE(intelligence_settings, '{}'::jsonb),
                '{scl}',
                ${JSON.stringify(merged)}::jsonb,
                true
            )
            WHERE id = ${workspaceId}::uuid
        `)
        invalidateIntelligenceSettings(workspaceId)
        await invalidateAgentSclCache(workspaceId)

        const view = readSclSettings({ scl: merged })
        res.json({ ok: true, settings: view })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL settings update failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update SCL settings' } })
    }
})

// GET /api/v1/scl/domain-regions?workspaceId=...
sclRouter.get('/domain-regions', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const result = await db.execute(sql`
            SELECT domain_region, COUNT(*)::int AS count
            FROM scl_concept_graphs
            WHERE workspace_id = ${workspaceId}::uuid
              AND domain_region IS NOT NULL
            GROUP BY domain_region
            ORDER BY count DESC, domain_region ASC
        `)
        const rows = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])
        const regions = (rows ?? []).map((r: any) => ({
            region: String(r.domain_region),
            count: Number(r.count ?? 0),
        }))
        res.json({ regions })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL domain regions query failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load domain regions' } })
    }
})

// GET /api/v1/scl/pii-preview?workspaceId=...
sclRouter.get('/pii-preview', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const result = await db.execute(sql`
            SELECT id, model, scrub_input_pattern, scrub_output_pattern, created_at
            FROM inference_logs
            WHERE workspace_id = ${workspaceId}::uuid
              AND (scrub_input_pattern IS NOT NULL OR scrub_output_pattern IS NOT NULL)
            ORDER BY created_at DESC
            LIMIT 1
        `)
        const rows = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])
        const row = rows?.[0]
        if (!row) {
            res.json({ available: false, reason: 'No scrubbed inference logs yet for this workspace.' })
            return
        }

        // Run a sample text through the live scrub pipeline so the user
        // can see what patterns are stripped without exposing the raw
        // un-scrubbed log content (we never store originals).
        const { scrubPII } = await import('@plexo/agent/scl/pii-scrub')
        const sample = 'Email john.doe@example.com or call +1 (555) 123-4567. SSN 123-45-6789. Card 4111 1111 1111 1111. $1,234.56.'
        const scrubbed = scrubPII(sample)

        res.json({
            available: true,
            latest: {
                id: String(row.id),
                model: String(row.model),
                inputPattern: row.scrub_input_pattern ?? null,
                outputPattern: row.scrub_output_pattern ?? null,
                createdAt: row.created_at,
            },
            sample: { original: sample, scrubbed },
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL PII preview failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load PII preview' } })
    }
})

sclRouter.patch('/config', async (req: Request, res: Response) => {
    const { workspaceId, ...overrides } = req.body as { workspaceId: string } & Partial<SclConfig>
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // Validate bounds
    const errors: string[] = []
    const validated: Partial<SclConfig> = {}
    for (const [key, bounds] of Object.entries(SCL_BOUNDS)) {
        const k = key as keyof SclConfig
        if (k in overrides) {
            const val = Number(overrides[k])
            if (isNaN(val) || val < bounds.min || val > bounds.max) {
                errors.push(`${key}: must be between ${bounds.min} and ${bounds.max}`)
            } else {
                validated[k] = val
            }
        }
    }

    if (errors.length > 0) {
        res.status(400).json({ error: { code: 'INVALID_CONFIG', message: errors.join('; ') } })
        return
    }

    try {
        // Merge into workspace settings.sclConfig
        const [ws] = await db.select({ settings: workspaces.settings }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        const current = (ws?.settings as Record<string, unknown>) ?? {}
        const currentScl = (current.sclConfig as Record<string, unknown>) ?? {}
        const merged = { ...currentScl, ...validated }

        await db.update(workspaces)
            .set({ settings: { ...current, sclConfig: merged } })
            .where(eq(workspaces.id, workspaceId))

        res.json({ ok: true, config: { ...SCL_DEFAULTS, ...merged } })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL config update failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update SCL config' } })
    }
})

// ── Phase 3b — Drift warning inbox ───────────────────────────────────────────
//
// The legacy `/drift` + `/drift/:id/resolve` endpoints already exist (further
// up in this file). Phase 3b adds a parallel `/drift-warnings` namespace
// with the inbox shape the UI consumes (status filter + counts) plus
// dedicated `/approve` and `/reject` verbs that match the rest of the
// Phase 3b inbox surfaces. Both verbs delegate to the same SCL core
// `resolveDrift` helper the legacy endpoint uses, so the state machine
// stays in one place.

const DRIFT_STATUSES = new Set(['pending', 'confirmed', 'rejected'])

// GET /api/v1/scl/drift-warnings?workspaceId=...&status=pending
sclRouter.get('/drift-warnings', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    const statusFilter = (req.query.status as string | undefined) ?? 'pending'
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!DRIFT_STATUSES.has(statusFilter) && statusFilter !== 'all') {
        res.status(400).json({ error: { code: 'INVALID_STATUS', message: `status must be one of: pending, confirmed, rejected, all` } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const result = statusFilter === 'all'
            ? await db.execute(sql`
                SELECT id, attractor_id, attractor_label, semantic_distance, threshold,
                       source, status, created_at, resolved_at
                FROM scl_drift_warnings
                WHERE workspace_id = ${workspaceId}::uuid
                ORDER BY created_at DESC
                LIMIT 200
            `)
            : await db.execute(sql`
                SELECT id, attractor_id, attractor_label, semantic_distance, threshold,
                       source, status, created_at, resolved_at
                FROM scl_drift_warnings
                WHERE workspace_id = ${workspaceId}::uuid AND status = ${statusFilter}
                ORDER BY created_at DESC
                LIMIT 200
            `)
        const rows = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])

        // Counts per status — single round trip so the inbox header can
        // show "12 pending, 4 confirmed, 2 rejected" without three calls.
        const countsResult = await db.execute(sql`
            SELECT status, COUNT(*)::int AS count
            FROM scl_drift_warnings
            WHERE workspace_id = ${workspaceId}::uuid
            GROUP BY status
        `)
        const countRows = pgRows(countsResult)
            ?? (Array.isArray(countsResult) ? (countsResult as any[]) : [])
        const counts: Record<string, number> = { pending: 0, confirmed: 0, rejected: 0 }
        for (const r of countRows) counts[String(r.status)] = Number(r.count ?? 0)

        res.json({
            warnings: (rows ?? []).map((r: any) => ({
                id: String(r.id),
                attractorId: String(r.attractor_id),
                attractorLabel: String(r.attractor_label),
                semanticDistance: Number(r.semantic_distance),
                threshold: Number(r.threshold),
                source: String(r.source),
                status: String(r.status),
                createdAt: r.created_at,
                resolvedAt: r.resolved_at,
            })),
            counts,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL drift inbox query failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load drift warnings' } })
    }
})

async function resolveDriftWarning(
    warningId: string,
    workspaceId: string,
    decision: 'confirm' | 'reject',
): Promise<{ ok: true; status: 'confirmed' | 'rejected' } | { error: string; code: string; status: number }> {
    const [warning] = await db.select()
        .from(sclDriftWarnings)
        .where(eq(sclDriftWarnings.id, warningId))
        .limit(1)
    if (!warning) return { error: 'Drift warning not found', code: 'NOT_FOUND', status: 404 }
    if (String(warning.workspaceId) !== workspaceId) {
        return { error: 'Workspace mismatch', code: 'FORBIDDEN', status: 403 }
    }
    if (warning.status !== 'pending') {
        return { error: `Warning already ${warning.status}`, code: 'ALREADY_RESOLVED', status: 400 }
    }

    if (decision === 'confirm') {
        try {
            const { loadGoldenRecord, saveGoldenRecord } = await import('@plexo/agent/scl/storage')
            const { resolveDrift } = await import('@plexo/scl-core')
            const record = await loadGoldenRecord(workspaceId)
            if (record) {
                const driftWarning = {
                    attractorId: warning.attractorId,
                    attractorLabel: warning.attractorLabel,
                    currentPosition: warning.currentPosition as number[],
                    proposedPosition: warning.proposedPosition as number[],
                    semanticDistance: warning.semanticDistance,
                    threshold: warning.threshold,
                    source: warning.source,
                    status: 'pending' as const,
                    createdAt: warning.createdAt.getTime(),
                }
                const updated = resolveDrift(record, driftWarning, 'confirm')
                await saveGoldenRecord(workspaceId, updated)
            }
        } catch (err) {
            logger.warn({ err, warningId }, 'Drift confirm — golden record update failed')
        }
    }

    const newStatus = decision === 'confirm' ? 'confirmed' : 'rejected'
    await db.update(sclDriftWarnings)
        .set({ status: newStatus, resolvedAt: new Date() })
        .where(eq(sclDriftWarnings.id, warningId))

    return { ok: true, status: newStatus }
}

// POST /api/v1/scl/drift-warnings/:id/approve
sclRouter.post('/drift-warnings/:id/approve', async (req: Request, res: Response) => {
    const warningId = String(req.params.id)
    const { workspaceId } = (req.body ?? {}) as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    try {
        const result = await resolveDriftWarning(warningId, workspaceId, 'confirm')
        if ('error' in result) {
            res.status(result.status).json({ error: { code: result.code, message: result.error } })
            return
        }
        res.json(result)
    } catch (err) {
        logger.error({ err, warningId }, 'SCL drift approve failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve drift warning' } })
    }
})

// POST /api/v1/scl/drift-warnings/:id/reject
sclRouter.post('/drift-warnings/:id/reject', async (req: Request, res: Response) => {
    const warningId = String(req.params.id)
    const { workspaceId } = (req.body ?? {}) as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    try {
        const result = await resolveDriftWarning(warningId, workspaceId, 'reject')
        if ('error' in result) {
            res.status(result.status).json({ error: { code: result.code, message: result.error } })
            return
        }
        res.json(result)
    } catch (err) {
        logger.error({ err, warningId }, 'SCL drift reject failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject drift warning' } })
    }
})

// ── Phase 3b — RSI proposals inbox ───────────────────────────────────────────
//
// rsi_proposals enum is `pending | approved | rejected` (no `dismissed`).
// Phase 3b honors the additive-only constraint and skips a 0079 migration —
// approve/reject is the full state machine. The UI labels reject as
// "Dismiss" for proposals the user just doesn't want to act on, but
// the underlying status transitions to `rejected`.

const RSI_STATUSES = new Set(['pending', 'approved', 'rejected'])

// GET /api/v1/scl/rsi-proposals?workspaceId=...&status=pending
sclRouter.get('/rsi-proposals', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    const statusFilter = (req.query.status as string | undefined) ?? 'pending'
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!RSI_STATUSES.has(statusFilter) && statusFilter !== 'all') {
        res.status(400).json({ error: { code: 'INVALID_STATUS', message: 'status must be one of: pending, approved, rejected, all' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const result = statusFilter === 'all'
            ? await db.execute(sql`
                SELECT id, anomaly_type, hypothesis, proposed_change, risk, status,
                       approved_at, rejected_at, created_at
                FROM rsi_proposals
                WHERE workspace_id = ${workspaceId}::uuid
                ORDER BY created_at DESC
                LIMIT 200
            `)
            : await db.execute(sql`
                SELECT id, anomaly_type, hypothesis, proposed_change, risk, status,
                       approved_at, rejected_at, created_at
                FROM rsi_proposals
                WHERE workspace_id = ${workspaceId}::uuid AND status = ${statusFilter}
                ORDER BY created_at DESC
                LIMIT 200
            `)
        const rows = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])

        const countsResult = await db.execute(sql`
            SELECT status, COUNT(*)::int AS count
            FROM rsi_proposals
            WHERE workspace_id = ${workspaceId}::uuid
            GROUP BY status
        `)
        const countRows = pgRows(countsResult)
            ?? (Array.isArray(countsResult) ? (countsResult as any[]) : [])
        const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0 }
        for (const r of countRows) counts[String(r.status)] = Number(r.count ?? 0)

        res.json({
            proposals: (rows ?? []).map((r: any) => ({
                id: String(r.id),
                anomalyType: String(r.anomaly_type),
                hypothesis: String(r.hypothesis),
                proposedChange: r.proposed_change ?? {},
                risk: String(r.risk),
                status: String(r.status),
                approvedAt: r.approved_at,
                rejectedAt: r.rejected_at,
                createdAt: r.created_at,
            })),
            counts,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL RSI inbox query failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load RSI proposals' } })
    }
})

async function transitionRsiProposal(
    proposalId: string,
    workspaceId: string,
    decision: 'approve' | 'reject',
): Promise<{ ok: true; status: 'approved' | 'rejected' } | { error: string; code: string; status: number }> {
    const result = await db.execute(sql`
        SELECT id, workspace_id, status
        FROM rsi_proposals
        WHERE id = ${proposalId}::uuid
        LIMIT 1
    `)
    const rows = pgRows(result)
        ?? (Array.isArray(result) ? (result as any[]) : [])
    const row = rows?.[0]
    if (!row) return { error: 'RSI proposal not found', code: 'NOT_FOUND', status: 404 }
    if (String(row.workspace_id) !== workspaceId) {
        return { error: 'Workspace mismatch', code: 'FORBIDDEN', status: 403 }
    }
    if (String(row.status) !== 'pending') {
        return { error: `Proposal already ${row.status}`, code: 'ALREADY_RESOLVED', status: 400 }
    }

    const newStatus = decision === 'approve' ? 'approved' : 'rejected'
    const tsCol = decision === 'approve' ? 'approved_at' : 'rejected_at'
    if (decision === 'approve') {
        await db.execute(sql`
            UPDATE rsi_proposals
            SET status = ${newStatus}::rsi_status, approved_at = NOW()
            WHERE id = ${proposalId}::uuid
        `)
    } else {
        await db.execute(sql`
            UPDATE rsi_proposals
            SET status = ${newStatus}::rsi_status, rejected_at = NOW()
            WHERE id = ${proposalId}::uuid
        `)
    }
    void tsCol
    return { ok: true, status: newStatus }
}

// POST /api/v1/scl/rsi-proposals/:id/approve
sclRouter.post('/rsi-proposals/:id/approve', async (req: Request, res: Response) => {
    const proposalId = String(req.params.id)
    const { workspaceId } = (req.body ?? {}) as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    try {
        const result = await transitionRsiProposal(proposalId, workspaceId, 'approve')
        if ('error' in result) {
            res.status(result.status).json({ error: { code: result.code, message: result.error } })
            return
        }
        res.json(result)
    } catch (err) {
        logger.error({ err, proposalId }, 'RSI approve failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to approve RSI proposal' } })
    }
})

// POST /api/v1/scl/rsi-proposals/:id/reject
sclRouter.post('/rsi-proposals/:id/reject', async (req: Request, res: Response) => {
    const proposalId = String(req.params.id)
    const { workspaceId } = (req.body ?? {}) as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    try {
        const result = await transitionRsiProposal(proposalId, workspaceId, 'reject')
        if ('error' in result) {
            res.status(result.status).json({ error: { code: result.code, message: result.error } })
            return
        }
        res.json(result)
    } catch (err) {
        logger.error({ err, proposalId }, 'RSI reject failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reject RSI proposal' } })
    }
})

// ── Phase 3b — Attractor browser ─────────────────────────────────────────────
//
// The browser surfaces `scl_concept_graphs` rows — one per task-level
// concept extraction — filterable by `domain_region` and a free-text
// `query` against the row id or domain region. Detail view returns the
// full `graph_json` + `mindset_object` for the JSON viewer.

// GET /api/v1/scl/attractors?workspaceId=&domain=&query=&limit=
sclRouter.get('/attractors', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    const domain = (req.query.domain as string | undefined) || null
    const query = ((req.query.query as string | undefined) || '').toLowerCase().trim()
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50))

    try {
        const result = domain
            ? await db.execute(sql`
                SELECT id, source_log_id, domain_region, created_at, updated_at
                FROM scl_concept_graphs
                WHERE workspace_id = ${workspaceId}::uuid AND domain_region = ${domain}
                ORDER BY created_at DESC
                LIMIT ${limit}
            `)
            : await db.execute(sql`
                SELECT id, source_log_id, domain_region, created_at, updated_at
                FROM scl_concept_graphs
                WHERE workspace_id = ${workspaceId}::uuid
                ORDER BY created_at DESC
                LIMIT ${limit}
            `)
        const rows = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])
        let items = (rows ?? []).map((r: any) => ({
            id: String(r.id),
            sourceLogId: r.source_log_id ? String(r.source_log_id) : null,
            domainRegion: r.domain_region ? String(r.domain_region) : null,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
        }))
        if (query) {
            items = items.filter(it =>
                it.id.toLowerCase().includes(query) ||
                (it.domainRegion ?? '').toLowerCase().includes(query),
            )
        }
        res.json({ attractors: items, total: items.length })
    } catch (err) {
        logger.error({ err, workspaceId }, 'SCL attractors query failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load attractors' } })
    }
})

// GET /api/v1/scl/attractors/:id?workspaceId=...
sclRouter.get('/attractors/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id)
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    try {
        const result = await db.execute(sql`
            SELECT id, source_log_id, workspace_id, domain_region, graph_json,
                   mindset_object, created_at, updated_at
            FROM scl_concept_graphs
            WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
            LIMIT 1
        `)
        const rows = pgRows(result)
            ?? (Array.isArray(result) ? (result as any[]) : [])
        const row = rows?.[0]
        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Attractor not found' } })
            return
        }
        res.json({
            attractor: {
                id: String(row.id),
                sourceLogId: row.source_log_id ? String(row.source_log_id) : null,
                domainRegion: row.domain_region ? String(row.domain_region) : null,
                graphJson: row.graph_json ?? {},
                mindsetObject: row.mindset_object ?? null,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
            },
        })
    } catch (err) {
        logger.error({ err, id }, 'SCL attractor detail failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load attractor' } })
    }
})
