// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 4 N.5 — Synthesis nightly job.
 *
 * Runs once per workspace at 03:00 UTC (overdue check via cron.ts'
 * INTERNAL_JOBS scheduler — see cron.ts for the firing engine).
 *
 * Pipeline order matters — each step feeds the next:
 *   1. Backfill embeddings for any memory_entries with NULL embedding
 *   2. kNN refresh (cluster does this internally — left here as a no-op
 *      seam for the future when we split the pipeline)
 *   3. Cluster (multi-resolution Louvain + Haiku labels + UMAP +
 *      Hungarian theme stability + memory_theme_history snapshot)
 *   4. Generate theme + link suggestions
 *   5. Evaluate SCL promotion (Phase 3 N.3)
 *   6. POST nexalog.com/api/cron/stale-archive (Hotel's endpoint)
 *
 * The route auth on the nexalog endpoint is `X-Cron-Secret` (NOT the
 * Plexo service-key). We read CRON_SECRET from the container env. If
 * unset, we log+skip without failing the rest of the pipeline.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'
import { clusterMemory } from '@plexo/agent/memory/cluster'
import { generateThemeSuggestions, generateLinkSuggestions } from '@plexo/agent/memory/suggest'
import { evaluateSclPromotion, snapshotThemeHistory } from '@plexo/agent/memory/scl'
import { storeMemory, embed as embedMemory } from '@plexo/agent/memory/store'
import { autoPromoteAboveThreshold } from '@plexo/agent/memory/promote'
import { loadSettingsFromInstances } from '@plexo/agent/providers/settings-from-instances'

const logger = pino({ name: 'synthesis-nightly' })

export interface SynthesisNightlyResult {
    workspaces: number
    totals: {
        embeddingsBackfilled: number
        themesPersisted: number
        suggestionsInserted: number
        sclPromoted: number
        sclDemoted: number
        /** Phase 5 — cross-app promotions (note→levio, asset→fonto, spend→fylo) */
        crossAppPromoted: number
        crossAppNoRoute: number
    }
    staleArchive: { ok: boolean; status: number | null; error: string | null }
    durationMs: number
}

/** Confidence threshold for nightly auto-promotion. Set via env so ops can
 *  raise/lower without a redeploy while we calibrate against real
 *  workspaces. Default 1.5 = `coherence × ln(size)` of a coherent theme
 *  with ~5 members at coherence 0.93 — well above the suggestion floor. */
function autoPromoteThreshold(): number {
    const raw = process.env.SYNTHESIS_AUTO_PROMOTE_THRESHOLD
    if (!raw) return 1.5
    const n = Number(raw)
    return Number.isFinite(n) ? n : 1.5
}

function autoPromoteEnabled(): boolean {
    // Default ON — promotion is the whole point of Phase 5. Operators can
    // disable via env if they want manual-only via the HTTP endpoint.
    return process.env.SYNTHESIS_AUTO_PROMOTE !== '0' && process.env.SYNTHESIS_AUTO_PROMOTE !== 'false'
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

/** Snapshot every persisted theme into memory_theme_history. Read straight
 *  from memory_themes since the cluster route has already persisted the new
 *  state by the time we run. */
async function snapshotAfterCluster(workspaceId: string, runId: string): Promise<number> {
    const rows = Array.from(await db.execute<{
        id: string
        level: number
        stable_id: string | null
        member_ids: string[]
        size: number
        coherence: number
    }>(sql`
        SELECT id, level, stable_id, member_ids, size, coherence
        FROM memory_themes
        WHERE workspace_id = ${workspaceId}::uuid
    `))
    if (rows.length === 0) return 0
    return await snapshotThemeHistory(
        workspaceId,
        runId,
        rows.map(r => ({
            id: r.id,
            level: r.level,
            stableId: r.stable_id ?? r.id,
            memberIds: r.member_ids ?? [],
            size: r.size,
            coherence: r.coherence,
        })),
    )
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

/**
 * Run the synthesis pipeline for one workspace.
 */
async function runForWorkspace(workspaceId: string): Promise<{
    embeddingsBackfilled: number
    themesPersisted: number
    suggestionsInserted: number
    sclPromoted: number
    sclDemoted: number
    crossAppPromoted: number
    crossAppNoRoute: number
}> {
    const t0 = Date.now()
    logger.info({ workspaceId }, 'synthesis-nightly: workspace start')

    let embeddingsBackfilled = 0
    let themesPersisted = 0
    let suggestionsInserted = 0
    let sclPromoted = 0
    let sclDemoted = 0
    let crossAppPromoted = 0
    let crossAppNoRoute = 0

    try {
        embeddingsBackfilled = await backfillEmbeddings(workspaceId)
    } catch (err) {
        logger.warn({ err, workspaceId }, 'synthesis-nightly: backfill failed — proceeding')
    }

    // 2/3) cluster (refreshKnnEdges happens inside).
    let runId: string | null = null
    try {
        const clusterResult = await clusterMemory(workspaceId)
        themesPersisted = clusterResult.summary.reduce((s, l) => s + l.count, 0)

        // Pull the run id we just inserted (cluster doesn't persist itself —
        // the route does, but this is the cron path). Insert a run row here.
        const runRows = Array.from(await db.execute<{ id: string }>(sql`
            INSERT INTO memory_theme_runs
                (workspace_id, n_entries, n_themes, n_subthemes, duration_ms, algo_version)
            VALUES
                (${workspaceId}::uuid,
                 ${Object.keys(clusterResult.umap).length},
                 ${clusterResult.summary.find(s => s.level === 1)?.count ?? 0},
                 ${clusterResult.summary.find(s => s.level === 2)?.count ?? 0},
                 ${clusterResult.durationMs},
                 ${clusterResult.algoVersion})
            RETURNING id
        `))
        runId = runRows[0]?.id ?? null

        // Persist themes from clusterResult into memory_themes — same shape
        // the route uses. Reusing the route's logic verbatim would mean
        // calling the http endpoint; doing the writes here is the simpler
        // path and keeps the cron self-contained.
        await persistClusterToDb(workspaceId, clusterResult)
    } catch (err) {
        logger.error({ err, workspaceId }, 'synthesis-nightly: cluster failed — aborting workspace')
        return {
            embeddingsBackfilled, themesPersisted, suggestionsInserted,
            sclPromoted, sclDemoted, crossAppPromoted, crossAppNoRoute,
        }
    }

    // 3a) snapshot theme history for SCL stability gate.
    if (runId) {
        try { await snapshotAfterCluster(workspaceId, runId) } catch (err) {
            logger.warn({ err, workspaceId, runId }, 'synthesis-nightly: history snapshot failed')
        }
    }

    // 4) suggestions
    try {
        const themeRes = await generateThemeSuggestions(workspaceId)
        const linkRes = await generateLinkSuggestions(workspaceId)
        suggestionsInserted = themeRes.inserted + linkRes.inserted
    } catch (err) {
        logger.warn({ err, workspaceId }, 'synthesis-nightly: suggestions failed')
    }

    // 5) SCL evaluation
    try {
        const scl = await evaluateSclPromotion(workspaceId)
        sclPromoted = scl.newlyPromoted.length
        sclDemoted = scl.newlyDemoted.length
    } catch (err) {
        logger.warn({ err, workspaceId }, 'synthesis-nightly: SCL eval failed')
    }

    // 6) Phase 5 — cross-app promotion. Auto-promote any pending suggestion
    //    that crossed the configured confidence threshold. Disabling env var
    //    SYNTHESIS_AUTO_PROMOTE=0 leaves promotion to the manual HTTP path.
    if (autoPromoteEnabled()) {
        try {
            const r = await autoPromoteAboveThreshold({
                workspaceId,
                confidenceThreshold: autoPromoteThreshold(),
            })
            crossAppPromoted = r.promoted
            crossAppNoRoute = r.noRoute
        } catch (err) {
            logger.warn({ err, workspaceId }, 'synthesis-nightly: auto-promote failed')
        }
    }

    logger.info(
        {
            workspaceId, embeddingsBackfilled, themesPersisted, suggestionsInserted,
            sclPromoted, sclDemoted, crossAppPromoted, crossAppNoRoute,
            durationMs: Date.now() - t0,
        },
        'synthesis-nightly: workspace complete',
    )

    return {
        embeddingsBackfilled, themesPersisted, suggestionsInserted,
        sclPromoted, sclDemoted, crossAppPromoted, crossAppNoRoute,
    }
}

/* ────── persistence helper (mirrors apps/api/src/routes/memory.ts) ────── */

function uuidArrayLiteral(ids: string[]): string {
    return `{${ids.map(id => `"${id.replace(/"/g, '\\"')}"`).join(',')}}`
}

async function persistClusterToDb(workspaceId: string, result: import('@plexo/agent/memory/cluster').ClusterMemoryResult): Promise<void> {
    // UMAP back onto entries
    for (const [id, xy] of Object.entries(result.umap)) {
        await db.execute(sql`
            UPDATE memory_entries
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{umap}', ${JSON.stringify(xy)}::jsonb, true)
            WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
        `)
    }

    const persistedByIdx = new Map<string, string>()
    const keyOf = (level: number, idx: number) => `${level}:${idx}`
    const byLevel: Record<number, import('@plexo/agent/memory/cluster').ClusteredMemory[]> = { 0: [], 1: [], 2: [] }
    for (const c of result.clusters) byLevel[c.level]!.push(c)

    for (const level of [0, 1, 2] as const) {
        const list = byLevel[level] ?? []
        for (let i = 0; i < list.length; i++) {
            const c = list[i]!
            const centroidLiteral = `[${c.centroid.join(',')}]`
            let parentId: string | null = null
            if (c.parentIdx != null && level > 0) {
                parentId = persistedByIdx.get(keyOf(level - 1, c.parentIdx)) ?? null
            }

            const memberIdsLiteral = uuidArrayLiteral(c.memberIds)
            const exemplarLiteral = c.exemplarIds && c.exemplarIds.length > 0 ? uuidArrayLiteral(c.exemplarIds) : null
            let themeId: string

            if (c.matchedPriorId) {
                themeId = c.matchedPriorId
                await db.execute(sql`
                    UPDATE memory_themes
                    SET label = ${c.label},
                        why = ${c.why},
                        member_ids = ${memberIdsLiteral}::uuid[],
                        exemplar_ids = ${exemplarLiteral}::uuid[],
                        size = ${c.memberIds.length},
                        coherence = ${c.coherence},
                        centroid = ${centroidLiteral}::vector,
                        level = ${level},
                        parent_id = ${parentId}::uuid,
                        stable_id = ${c.stableId},
                        last_member_at = NOW(),
                        updated_at = NOW()
                    WHERE id = ${themeId}::uuid AND workspace_id = ${workspaceId}::uuid
                `)
            } else {
                const inserted = Array.from(await db.execute<{ id: string }>(sql`
                    INSERT INTO memory_themes
                        (workspace_id, label, why, member_ids, exemplar_ids, centroid,
                         size, coherence, last_member_at, level, parent_id, stable_id)
                    VALUES
                        (${workspaceId}::uuid, ${c.label}, ${c.why}, ${memberIdsLiteral}::uuid[],
                         ${exemplarLiteral}::uuid[], ${centroidLiteral}::vector,
                         ${c.memberIds.length}, ${c.coherence}, NOW(),
                         ${level}, ${parentId}::uuid, ${c.stableId})
                    RETURNING id
                `))
                themeId = inserted[0]!.id
            }
            persistedByIdx.set(keyOf(level, i), themeId)
        }
    }

    const keepIds = Array.from(persistedByIdx.values())
    if (keepIds.length > 0) {
        const keepLiteral = uuidArrayLiteral(keepIds)
        await db.execute(sql`
            DELETE FROM memory_themes
            WHERE workspace_id = ${workspaceId}::uuid
              AND id <> ALL(${keepLiteral}::uuid[])
        `)
    } else {
        await db.execute(sql`DELETE FROM memory_themes WHERE workspace_id = ${workspaceId}::uuid`)
    }
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
            totals: {
                embeddingsBackfilled: 0, themesPersisted: 0, suggestionsInserted: 0,
                sclPromoted: 0, sclDemoted: 0, crossAppPromoted: 0, crossAppNoRoute: 0,
            },
            staleArchive: { ok: false, status: null, error: 'workspace listing failed' },
            durationMs: Date.now() - t0,
        }
    }

    const totals = {
        embeddingsBackfilled: 0,
        themesPersisted: 0,
        suggestionsInserted: 0,
        sclPromoted: 0,
        sclDemoted: 0,
        crossAppPromoted: 0,
        crossAppNoRoute: 0,
    }

    for (const workspaceId of workspaces) {
        try {
            const r = await runForWorkspace(workspaceId)
            totals.embeddingsBackfilled += r.embeddingsBackfilled
            totals.themesPersisted += r.themesPersisted
            totals.suggestionsInserted += r.suggestionsInserted
            totals.sclPromoted += r.sclPromoted
            totals.sclDemoted += r.sclDemoted
            totals.crossAppPromoted += r.crossAppPromoted
            totals.crossAppNoRoute += r.crossAppNoRoute
        } catch (err) {
            logger.error({ err, workspaceId }, 'synthesis-nightly: workspace pass threw — continuing')
        }
    }

    // 6) Trigger Hotel's stale-archive
    const staleArchive = await pingNexalogStaleArchive()

    const durationMs = Date.now() - t0
    logger.info({ workspaces: workspaces.length, totals, staleArchive, durationMs }, 'synthesis-nightly: complete')

    return { workspaces: workspaces.length, totals, staleArchive, durationMs }
}
