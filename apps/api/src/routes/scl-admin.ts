// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL admin endpoints for observability, compression, expansion, and E2E testing.
 *
 * GET  /inference-logs      — list recent inference logs
 * GET  /scl-graphs          — list recent SCL concept graphs
 * POST /compress            — compress SCL-S graphs into MindsetObject
 * POST /expand              — expand MindsetObject for a task stimulus
 * GET  /mindset/:workspaceId — get workspace mindset
 */

import { Router, type Router as RouterType } from 'express'
import pino from 'pino'
import { db, sql } from '@plexo/db'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { UUID_RE } from '../validation.js'

const logger = pino({ name: 'scl-admin' })

export const sclAdminRouter: RouterType = Router()

// GET /inference-logs — super admin only (cross-workspace global view)
sclAdminRouter.get('/inference-logs', async (req, res) => {
    if (!req.user?.isSuperAdmin) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Super admin required' } })
        return
    }
    const limit = Math.min(Number(req.query.limit) || 20, 100)

    try {
        const rows = await db.execute(sql`
            SELECT id, model, provider, input_tokens, output_tokens, latency_ms,
                   domain_region, task_type, success, created_at
            FROM inference_logs
            ORDER BY created_at DESC
            LIMIT ${limit}
        `)
        res.json(rows)
    } catch (err) {
        res.status(500).json({ error: 'Failed to query inference logs' })
    }
})

// GET /scl-graphs — super admin only (cross-workspace global view)
sclAdminRouter.get('/scl-graphs', async (req, res) => {
    if (!req.user?.isSuperAdmin) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Super admin required' } })
        return
    }
    const limit = Math.min(Number(req.query.limit) || 20, 100)

    try {
        const rows = await db.execute(sql`
            SELECT id, source_log_id, workspace_id, domain_region, graph_json, created_at
            FROM scl_concept_graphs
            ORDER BY created_at DESC
            LIMIT ${limit}
        `)
        res.json(rows)
    } catch (err) {
        res.status(500).json({ error: 'Failed to query SCL graphs' })
    }
})

// POST /compress — compress SCL-S graphs into a MindsetObject
sclAdminRouter.post('/compress', async (req, res) => {
    const { domainRegion, workspaceId, useSynthetic } = req.body as {
        domainRegion?: string
        workspaceId?: string
        useSynthetic?: boolean
    }

    if (workspaceId && !await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { compressToMindsetObject } = await import('@plexo/agent/scl/compressor')

        let graphs: any[] = []

        // Fetch real graphs
        const regionFilter = domainRegion ? sql` AND domain_region = ${domainRegion}` : sql``
        const wsFilter = workspaceId ? sql` AND workspace_id = ${workspaceId}::uuid` : sql``
        const rows = await db.execute(sql`
            SELECT graph_json FROM scl_concept_graphs
            WHERE graph_json IS NOT NULL ${regionFilter} ${wsFilter}
            ORDER BY created_at DESC LIMIT 200
        `)
        graphs = rows.map((r: any) => r.graph_json).filter(Boolean)

        // If useSynthetic and not enough real data, generate synthetic graphs
        if (useSynthetic && graphs.length < 10) {
            const tools = ['read_file', 'shell', 'write_file', 'web_search', 'code_edit']
            const types = ['coding', 'ops', 'research', 'automation']
            for (let i = graphs.length; i < 20; i++) {
                graphs.push({
                    id: `synthetic-${i}`,
                    domainRegion: domainRegion || 'code',
                    taskType: types[i % types.length],
                    toolsUsed: tools.slice(0, 2 + (i % 3)),
                    skillsActivated: [],
                    agentCount: 1,
                    stepCount: 3 + (i % 5),
                    quality: 0.6 + Math.random() * 0.4,
                    timestamp: new Date().toISOString(),
                })
            }
        }

        const mindset = compressToMindsetObject(graphs, workspaceId || 'admin-test')

        // Store in workspace_mindsets if workspaceId provided
        if (workspaceId) {
            await db.execute(sql`
                INSERT INTO workspace_mindsets (workspace_id, mindset_object, task_count, version)
                VALUES (${workspaceId}::uuid, ${JSON.stringify(mindset)}::jsonb, ${graphs.length}, 1)
                ON CONFLICT (workspace_id) DO UPDATE SET
                    mindset_object = EXCLUDED.mindset_object,
                    task_count = EXCLUDED.task_count,
                    version = workspace_mindsets.version + 1,
                    updated_at = NOW()
            `)
        }

        res.json(mindset)
    } catch (err) {
        logger.error({ err }, 'SCL compression failed')
        res.status(500).json({ error: 'Compression failed' })
    }
})

// POST /expand — expand a MindsetObject for a task stimulus
sclAdminRouter.post('/expand', async (req, res) => {
    const { stimulus, taskType, workspaceId } = req.body as {
        stimulus?: string
        taskType?: string
        workspaceId?: string
    }

    if (!stimulus) {
        res.status(400).json({ error: 'stimulus required' })
        return
    }
    if (workspaceId && !await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { expandMindsetObject } = await import('@plexo/agent/scl/expander')
        const { compressToMindsetObject } = await import('@plexo/agent/scl/compressor')

        let mindset: any = null

        // Try loading from DB
        if (workspaceId) {
            const rows = await db.execute(sql`
                SELECT mindset_object FROM workspace_mindsets WHERE workspace_id = ${workspaceId}::uuid
            `)
            if (rows[0]) mindset = (rows[0] as Record<string, unknown>).mindset_object
        }

        // If no stored mindset, create a minimal one from available graphs
        if (!mindset) {
            const rows = await db.execute(sql`
                SELECT graph_json FROM scl_concept_graphs
                WHERE graph_json IS NOT NULL
                ORDER BY created_at DESC LIMIT 50
            `)
            const graphs = rows.map((r: any) => r.graph_json).filter(Boolean)

            if (graphs.length === 0) {
                // Create synthetic for testing
                const tools = ['read_file', 'shell', 'write_file', 'web_search']
                const synth = Array.from({ length: 5 }, (_, i) => ({
                    id: `synth-${i}`,
                    domainRegion: 'code',
                    taskType: 'coding',
                    toolsUsed: tools.slice(0, 2 + (i % 2)),
                    skillsActivated: [],
                    agentCount: 1,
                    stepCount: 3,
                    quality: 0.8,
                    timestamp: new Date().toISOString(),
                }))
                mindset = compressToMindsetObject(synth, workspaceId || 'expand-test')
            } else {
                mindset = compressToMindsetObject(graphs, workspaceId || 'expand-test')
            }
        }

        const expanded = expandMindsetObject(mindset, {
            taskDescription: stimulus,
            taskType: taskType || 'unknown',
        })

        res.json(expanded)
    } catch (err) {
        logger.error({ err }, 'SCL expansion failed')
        res.status(500).json({ error: 'Expansion failed' })
    }
})

// POST /backfill — reprocess missed SCL mutations for completed tasks
// Finds completed tasks that were never reflected into the Golden Record
// and runs reflectAndMutate on each. Protected to super admin only.
sclAdminRouter.post('/backfill', async (req, res) => {
    if (!req.user?.isSuperAdmin) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Super admin required' } })
        return
    }

    const days = Math.min(Number(req.body?.days) || 30, 90)
    const batchSize = Math.min(Number(req.body?.batchSize) || 5, 20)
    const batchDelayMs = Math.min(Number(req.body?.batchDelayMs) || 2000, 10000)
    const workspaceId = req.body?.workspaceId as string | undefined

    try {
        // Find completed tasks with quality >= 0.3 from the last N days
        // that have no corresponding learning_events row with source_ref = 'reflect:<taskId>'
        const wsFilter = workspaceId ? sql` AND t.workspace_id = ${workspaceId}::uuid` : sql``
        const candidateRows = await db.execute<{
            id: string
            workspace_id: string
            type: string
            quality_score: number
            outcome_summary: string
            completed_at: Date
            created_at: Date
        }>(sql`
            SELECT t.id, t.workspace_id, t.type, t.quality_score,
                   t.outcome_summary, t.completed_at, t.created_at
            FROM tasks t
            WHERE t.status = 'complete'
              AND t.quality_score >= 0.3
              AND t.outcome_summary IS NOT NULL
              AND LENGTH(t.outcome_summary) >= 30
              AND t.completed_at >= NOW() - INTERVAL '1 day' * ${days}
              ${wsFilter}
              AND NOT EXISTS (
                  SELECT 1 FROM learning_events le
                  WHERE le.source_ref = 'reflect:' || t.id
                    AND le.event_type = 'scl_mutation'
              )
            ORDER BY t.completed_at ASC
        `)

        const candidates = candidateRows as unknown as Array<{
            id: string
            workspace_id: string
            type: string
            quality_score: number
            outcome_summary: string
            completed_at: Date
            created_at: Date
        }>

        logger.info({ candidates: candidates.length, days, workspaceId }, 'SCL backfill: found candidates')

        let processed = 0
        let skipped = 0
        let failed = 0
        const errors: Array<{ taskId: string; error: string }> = []

        // Lazy-import agent modules
        const { reflectAndMutate } = await import('@plexo/agent/scl/reflect-scl')
        const { resolveEmbeddingProvider } = await import('@plexo/agent/scl/embedding-provider')

        // Process in batches
        for (let i = 0; i < candidates.length; i += batchSize) {
            const batch = candidates.slice(i, i + batchSize)

            for (const task of batch) {
                try {
                    const embeddingProvider = await resolveEmbeddingProvider(task.workspace_id)

                    const ctx = {
                        workspaceId: task.workspace_id,
                        taskId: task.id,
                        goal: '(backfill)',
                        taskType: task.type,
                        toolsUsed: [],
                        qualityScore: task.quality_score,
                        outcomeSummary: task.outcome_summary,
                        stepCount: 0,
                        durationMs: 0,
                    }

                    const result = await reflectAndMutate(ctx, embeddingProvider)
                    if (result.mutated) {
                        processed++
                    } else {
                        skipped++
                    }
                } catch (err) {
                    failed++
                    errors.push({
                        taskId: task.id,
                        error: err instanceof Error ? err.message : String(err),
                    })
                    logger.warn({ err, taskId: task.id }, 'SCL backfill: task failed')
                }
            }

            // Delay between batches to avoid rate limits
            if (i + batchSize < candidates.length) {
                await new Promise(resolve => setTimeout(resolve, batchDelayMs))
            }
        }

        logger.info({ processed, skipped, failed, total: candidates.length }, 'SCL backfill complete')
        res.json({
            total: candidates.length,
            processed,
            skipped,
            failed,
            errors: errors.slice(0, 10), // Cap error detail
        })
    } catch (err) {
        logger.error({ err }, 'SCL backfill failed')
        res.status(500).json({ error: 'Backfill failed' })
    }
})

// GET /mindset/:workspaceId — get workspace mindset + golden record
// Returns both the legacy mindset_object and the canonical golden_record
// so UI components (RegionMap, AttractorBrowser, PromotionLog) can read the
// SCL lattice directly from this endpoint.
sclAdminRouter.get('/mindset/:workspaceId', async (req, res) => {
    const workspaceId = String(req.params.workspaceId ?? '')
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const rows = await db.execute<{
            mindset_object: unknown
            golden_record: unknown
            golden_record_version: string | null
            version: number
            task_count: number
            updated_at: Date
        }>(sql`
            SELECT mindset_object, golden_record, golden_record_version, version, task_count, updated_at
            FROM workspace_mindsets
            WHERE workspace_id = ${workspaceId}::uuid
        `)
        if (rows.length === 0) {
            res.status(404).json({ error: 'No mindset for workspace' })
            return
        }
        const row = rows[0]!
        res.json({
            mindsetObject: row.mindset_object,
            goldenRecord: row.golden_record,
            goldenRecordVersion: row.golden_record_version,
            version: row.version,
            taskCount: row.task_count,
            updatedAt: row.updated_at,
            // legacy snake_case for any existing consumers
            mindset_object: row.mindset_object,
            golden_record: row.golden_record,
        })
    } catch (err) {
        res.status(500).json({ error: 'Failed to query mindset' })
    }
})
