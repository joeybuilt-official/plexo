// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Nightly memory housekeeping job.
 *
 * Runs once per workspace at 03:00 UTC (overdue check via cron.ts'
 * INTERNAL_JOBS scheduler — see cron.ts for the firing engine).
 *
 * Post-SCL pipeline (lean):
 *   1. Backfill embeddings for any memory_entries with NULL embedding
 *      (atomic-fact write paths embed inline, but cold-start workspaces
 *      and historical rows still benefit from a nightly sweep).
 *   2. POST nexalog.com/api/cron/stale-archive (Hotel's endpoint).
 *
 * The route auth on the nexalog endpoint is `X-Cron-Secret` (NOT the
 * Plexo service-key). We read CRON_SECRET from the container env. If
 * unset, we log+skip without failing the rest of the pipeline.
 *
 * Pre-2026-05-20 this job also ran multi-resolution Louvain clustering,
 * theme persistence, link-suggestion generation, SCL promotion, and
 * cross-app suggestion promotion. All removed alongside the SCL teardown
 * (Sprint A′ Lane 1). Graphiti is now the canonical structure layer; the
 * postgres synthesis stack is gone.
 */
import pino from 'pino'
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { embed as embedMemory } from '@plexo/agent/memory/store'
import { loadSettingsFromInstances } from '@plexo/agent/providers/settings-from-instances'

const logger = pino({ name: 'synthesis-nightly' })

export interface SynthesisNightlyResult {
    workspaces: number
    totals: {
        embeddingsBackfilled: number
    }
    staleArchive: { ok: boolean; status: number | null; error: string | null }
    durationMs: number
}

/** Backfill embeddings for any memory_entries with NULL embedding in this
 *  workspace. Caps the pass at 500 entries per workspace per run so a huge
 *  cold-start pile doesn't dominate the nightly window. */
async function backfillEmbeddings(workspaceId: string, cap = 500): Promise<number> {
    const aiSettings = (await loadSettingsFromInstances(workspaceId)) ?? undefined
    const rows = Array.from(await db.execute<{ id: string; content: string }>(sql`
        SELECT id, content
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
          AND embedding IS NULL
          AND content IS NOT NULL
          AND length(content) > 0
        ORDER BY created_at DESC
        LIMIT ${cap}
    `))
    if (rows.length === 0) return 0

    let written = 0
    for (const r of rows) {
        try {
            const vec = await embedMemory(r.content, workspaceId, aiSettings)
            if (!vec || vec.length === 0) continue
            const literal = `[${vec.join(',')}]`
            await db.execute(sql`
                UPDATE memory_entries
                SET embedding = ${literal}::vector
                WHERE id = ${r.id}::uuid AND workspace_id = ${workspaceId}::uuid
            `)
            written++
        } catch (err) {
            logger.warn({ err, workspaceId, entryId: r.id }, 'synthesis-nightly: embed backfill failed (skip)')
        }
    }
    return written
}

/** Trigger Hotel's stale-archive endpoint. Authenticated via X-Cron-Secret
 *  (NOT the plexo service-key — different contract, see route source). */
async function pingNexalogStaleArchive(): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const secret = process.env.CRON_SECRET
    if (!secret) {
        logger.warn('synthesis-nightly: CRON_SECRET unset — skipping nexalog stale-archive call')
        return { ok: false, status: null, error: 'CRON_SECRET not set' }
    }
    const url = (process.env.NEXALOG_URL?.replace(/\/+$/, '') ?? 'https://nexalog.com') + '/api/cron/stale-archive'
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'X-Cron-Secret': secret,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ source: 'plexo-synthesis-nightly' }),
            signal: AbortSignal.timeout(10 * 60 * 1000),
        })
        if (!resp.ok) {
            const text = await resp.text().catch(() => '')
            return { ok: false, status: resp.status, error: text.slice(0, 240) }
        }
        return { ok: true, status: resp.status, error: null }
    } catch (err) {
        return { ok: false, status: null, error: err instanceof Error ? err.message : String(err) }
    }
}

async function runForWorkspace(workspaceId: string): Promise<{ embeddingsBackfilled: number }> {
    const t0 = Date.now()
    logger.info({ workspaceId }, 'synthesis-nightly: workspace start')
    let embeddingsBackfilled = 0
    try {
        embeddingsBackfilled = await backfillEmbeddings(workspaceId)
    } catch (err) {
        logger.warn({ err, workspaceId }, 'synthesis-nightly: backfill failed')
    }
    logger.info({ workspaceId, embeddingsBackfilled, durationMs: Date.now() - t0 }, 'synthesis-nightly: workspace complete')
    return { embeddingsBackfilled }
}

/**
 * Top-level orchestrator. Walk every workspace, run the pipeline, then
 * call out to nexalog. Failures are isolated per workspace — one bad
 * workspace doesn't stop the rest.
 */
export async function runSynthesisNightly(): Promise<SynthesisNightlyResult> {
    const t0 = Date.now()

    let workspaces: string[] = []
    try {
        const rows = await db.execute<{ id: string }>(sql`
            SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 100
        `)
        workspaces = rows.map(r => r.id)
    } catch (err) {
        logger.error({ err }, 'synthesis-nightly: failed to list workspaces')
        return {
            workspaces: 0,
            totals: { embeddingsBackfilled: 0 },
            staleArchive: { ok: false, status: null, error: 'workspace listing failed' },
            durationMs: Date.now() - t0,
        }
    }

    const totals = { embeddingsBackfilled: 0 }

    for (const workspaceId of workspaces) {
        try {
            const r = await runForWorkspace(workspaceId)
            totals.embeddingsBackfilled += r.embeddingsBackfilled
        } catch (err) {
            logger.error({ err, workspaceId }, 'synthesis-nightly: workspace pass threw — continuing')
        }
    }

    const staleArchive = await pingNexalogStaleArchive()

    const durationMs = Date.now() - t0
    logger.info({ workspaces: workspaces.length, totals, staleArchive, durationMs }, 'synthesis-nightly: complete')

    return { workspaces: workspaces.length, totals, staleArchive, durationMs }
}
