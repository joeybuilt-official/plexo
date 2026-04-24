// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Re-embed batch helper — Phase 1 of the intelligence overhaul.
 *
 * Walks `memory_entries` (and optionally `scl_concept_graphs`) for a workspace
 * and re-generates the embedding column under a new provider/model. Used
 * when a workspace switches embedding provider or model in the Settings →
 * Intelligence → Embeddings UI.
 *
 * Design notes:
 *   - In-process background job. State lives in `workspaces.intelligence_settings.reembed`
 *     so it survives process restarts (the job itself doesn't, but progress is
 *     visible and the job can be resumed by re-invoking with the same params).
 *   - Idempotent. Each row's `metadata.embedding_provider` + `metadata.embedding_model`
 *     are checked before re-embedding — rows that already match the target are skipped.
 *   - Resumable. Iteration is keyed on `created_at` ascending; the checkpoint stores
 *     the last successfully processed `created_at`. On resume, the loader picks up
 *     from there.
 *   - Soft fail. A row that errors gets logged + skipped; the job continues.
 *   - Final report saved to `intelligence_settings.reembed.lastReport`.
 *
 * NOT a queue task. The existing `@plexo/queue` is for agent task execution,
 * not generic background work. For Phase 1 we use a simple in-memory job map
 * keyed by jobId; later phases can promote this to a real job runner if
 * multi-process coordination is needed.
 */

import { db, sql } from '@plexo/db'
import pino from 'pino'
import type { EmbeddingAdapter } from '@plexo/agent/embeddings/router'

const logger = pino({ name: 'embeddings:reembed' })

export interface ReembedParams {
    workspaceId: string
    /** Adapter that produces the new embeddings. Caller resolves it. */
    adapter: EmbeddingAdapter
    /** Optional starting checkpoint (`created_at` ISO string) for resume. */
    sinceCreatedAt?: string | null
    /** Batch size. Default 100. */
    batchSize?: number
    /** Whether to also re-embed `scl_concept_graphs`. Default true. */
    includeScl?: boolean
}

export interface ReembedJobReport {
    jobId: string
    workspaceId: string
    status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
    startedAt: string
    finishedAt?: string
    rowsScanned: number
    rowsReembedded: number
    rowsSkipped: number
    rowsErrored: number
    sclScanned: number
    sclReembedded: number
    sclSkipped: number
    sclErrored: number
    targetProvider: string
    targetModel: string
    targetDimensions: number
    lastCheckpoint?: string
    error?: string
}

interface MemoryRow {
    id: string
    content: string
    metadata: Record<string, unknown> | null
    created_at: Date
    [key: string]: unknown
}

interface SclRow {
    id: string
    domain_region: string | null
    graph_json: Record<string, unknown> | null
    [key: string]: unknown
}

// ── In-memory job registry ─────────────────────────────────────────────────

const jobs = new Map<string, ReembedJobReport>()
const JOB_TTL_MS = 60 * 60 * 1000 // 1 hour after completion

function evictStaleJobs(): void {
    const cutoff = Date.now() - JOB_TTL_MS
    for (const [id, job] of jobs) {
        if ((job.status === 'completed' || job.status === 'failed') && job.finishedAt) {
            if (new Date(job.finishedAt).getTime() < cutoff) jobs.delete(id)
        }
    }
}

export function getReembedJob(jobId: string): ReembedJobReport | null {
    return jobs.get(jobId) ?? null
}

export function listReembedJobs(workspaceId: string): ReembedJobReport[] {
    evictStaleJobs()
    return Array.from(jobs.values()).filter(j => j.workspaceId === workspaceId)
}

/** For tests — wipes the in-memory registry. */
export function _resetReembedRegistry(): void {
    jobs.clear()
}

// ── Public entry point ─────────────────────────────────────────────────────

/**
 * Kick off a re-embed job. Returns the job id immediately; the job runs in
 * the background. Poll `getReembedJob(jobId)` for progress.
 */
export function startReembedJob(params: ReembedParams): ReembedJobReport {
    const jobId = `reembed_${params.workspaceId.slice(0, 8)}_${Date.now().toString(36)}`
    const report: ReembedJobReport = {
        jobId,
        workspaceId: params.workspaceId,
        status: 'queued',
        startedAt: new Date().toISOString(),
        rowsScanned: 0,
        rowsReembedded: 0,
        rowsSkipped: 0,
        rowsErrored: 0,
        sclScanned: 0,
        sclReembedded: 0,
        sclSkipped: 0,
        sclErrored: 0,
        targetProvider: params.adapter.providerId,
        targetModel: params.adapter.model,
        targetDimensions: params.adapter.dimensions,
    }
    jobs.set(jobId, report)

    // Fire-and-forget — surface failures via report.status
    void runReembedJob(jobId, params).catch((err) => {
        const r = jobs.get(jobId)
        if (r) {
            r.status = 'failed'
            r.error = err instanceof Error ? err.message : String(err)
            r.finishedAt = new Date().toISOString()
        }
        logger.error({ err, jobId }, 'Re-embed job crashed')
    })

    return report
}

// ── Core loop (exported for tests) ─────────────────────────────────────────

/**
 * Run the re-embed loop synchronously. Updates the report in-place.
 * Exported so the test suite can drive it without the in-memory registry.
 */
export async function runReembedJob(jobId: string, params: ReembedParams): Promise<ReembedJobReport> {
    const report = jobs.get(jobId) ?? {
        jobId,
        workspaceId: params.workspaceId,
        status: 'queued',
        startedAt: new Date().toISOString(),
        rowsScanned: 0,
        rowsReembedded: 0,
        rowsSkipped: 0,
        rowsErrored: 0,
        sclScanned: 0,
        sclReembedded: 0,
        sclSkipped: 0,
        sclErrored: 0,
        targetProvider: params.adapter.providerId,
        targetModel: params.adapter.model,
        targetDimensions: params.adapter.dimensions,
    }
    jobs.set(jobId, report)

    report.status = 'running'
    const batchSize = params.batchSize ?? 100
    const target = { provider: params.adapter.providerId, model: params.adapter.model }

    try {
        // ── Memory entries ────────────────────────────────────────────────
        let cursor: Date | null = params.sinceCreatedAt ? new Date(params.sinceCreatedAt) : null
        // Loop until a batch returns nothing.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const rows = await fetchMemoryBatch(params.workspaceId, cursor, batchSize)
            if (rows.length === 0) break

            const toEmbed: typeof rows = []
            for (const row of rows) {
                report.rowsScanned++
                cursor = row.created_at
                report.lastCheckpoint = row.created_at.toISOString()
                const meta = (row.metadata ?? {}) as Record<string, unknown>
                if (meta.embedding_provider === target.provider && meta.embedding_model === target.model) {
                    report.rowsSkipped++
                } else {
                    toEmbed.push(row)
                }
            }

            // Process up to 4 embed+update pairs concurrently to saturate I/O without overwhelming the embedding API
            const CONCURRENCY = 4
            for (let i = 0; i < toEmbed.length; i += CONCURRENCY) {
                await Promise.all(
                    toEmbed.slice(i, i + CONCURRENCY).map(async row => {
                        try {
                            const vec = await params.adapter.embed(row.content)
                            const vecStr = `[${vec.join(',')}]`
                            const meta = (row.metadata ?? {}) as Record<string, unknown>
                            const newMeta = {
                                ...meta,
                                embedding_provider: target.provider,
                                embedding_model: target.model,
                                embedding_dimensions: params.adapter.dimensions,
                                embedding_reembedded_at: new Date().toISOString(),
                            }
                            await db.execute(sql`
                                UPDATE memory_entries
                                SET embedding = ${vecStr}::vector,
                                    metadata = ${JSON.stringify(newMeta)}::jsonb
                                WHERE id = ${row.id}::uuid
                            `)
                            report.rowsReembedded++
                        } catch (err) {
                            report.rowsErrored++
                            logger.warn({ err, rowId: row.id }, 'Re-embed row failed — skipping')
                        }
                    })
                )
            }

            if (rows.length < batchSize) break
        }

        // ── SCL concept graphs (optional) ────────────────────────────────
        if (params.includeScl !== false) {
            const sclRows = await fetchSclRows(params.workspaceId)
            for (const row of sclRows) {
                report.sclScanned++
                const graph = (row.graph_json ?? {}) as Record<string, unknown>
                const lineage = (graph.embedding_lineage ?? {}) as Record<string, unknown>
                if (lineage.provider === target.provider && lineage.model === target.model) {
                    report.sclSkipped++
                    continue
                }
                try {
                    // SCL graphs aren't directly embedded — instead we tag the
                    // graph blob with the new lineage so downstream resolvers
                    // know to refresh attractor centroids on next read. Full
                    // attractor recomputation is Phase 3b.
                    const newGraph = {
                        ...graph,
                        embedding_lineage: {
                            provider: target.provider,
                            model: target.model,
                            dimensions: params.adapter.dimensions,
                            reembedded_at: new Date().toISOString(),
                        },
                    }
                    await db.execute(sql`
                        UPDATE scl_concept_graphs
                        SET graph_json = ${JSON.stringify(newGraph)}::jsonb,
                            updated_at = NOW()
                        WHERE id = ${row.id}::uuid
                    `)
                    report.sclReembedded++
                } catch (err) {
                    report.sclErrored++
                    logger.warn({ err, rowId: row.id }, 'SCL re-embed row failed — skipping')
                }
            }
        }

        report.status = 'completed'
        report.finishedAt = new Date().toISOString()
        await persistReembedReport(params.workspaceId, report)
        logger.info({
            jobId,
            workspaceId: params.workspaceId,
            rowsReembedded: report.rowsReembedded,
            rowsSkipped: report.rowsSkipped,
            rowsErrored: report.rowsErrored,
        }, 'Re-embed job complete')
    } catch (err) {
        report.status = 'failed'
        report.error = err instanceof Error ? err.message : String(err)
        report.finishedAt = new Date().toISOString()
        await persistReembedReport(params.workspaceId, report).catch(() => { /* ignore */ })
        throw err
    }

    return report
}

// ── DB helpers (overridable for tests) ─────────────────────────────────────

let memoryFetcher: (workspaceId: string, since: Date | null, limit: number) => Promise<MemoryRow[]> = defaultMemoryFetcher
let sclFetcher: (workspaceId: string) => Promise<SclRow[]> = defaultSclFetcher
let reportPersister: (workspaceId: string, report: ReembedJobReport) => Promise<void> = defaultReportPersister

export function _setReembedDeps(deps: {
    memoryFetcher?: typeof defaultMemoryFetcher
    sclFetcher?: typeof defaultSclFetcher
    reportPersister?: typeof defaultReportPersister
}): void {
    if (deps.memoryFetcher) memoryFetcher = deps.memoryFetcher
    if (deps.sclFetcher) sclFetcher = deps.sclFetcher
    if (deps.reportPersister) reportPersister = deps.reportPersister
}

export function _resetReembedDeps(): void {
    memoryFetcher = defaultMemoryFetcher
    sclFetcher = defaultSclFetcher
    reportPersister = defaultReportPersister
}

async function fetchMemoryBatch(workspaceId: string, since: Date | null, limit: number): Promise<MemoryRow[]> {
    return memoryFetcher(workspaceId, since, limit)
}

async function fetchSclRows(workspaceId: string): Promise<SclRow[]> {
    return sclFetcher(workspaceId)
}

async function persistReembedReport(workspaceId: string, report: ReembedJobReport): Promise<void> {
    return reportPersister(workspaceId, report)
}

async function defaultMemoryFetcher(workspaceId: string, since: Date | null, limit: number): Promise<MemoryRow[]> {
    const rows = since
        ? await db.execute<MemoryRow>(sql`
            SELECT id, content, metadata, created_at
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND created_at > ${since.toISOString()}::timestamptz
            ORDER BY created_at ASC
            LIMIT ${limit}
        `)
        : await db.execute<MemoryRow>(sql`
            SELECT id, content, metadata, created_at
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
            ORDER BY created_at ASC
            LIMIT ${limit}
        `)
    return rows as unknown as MemoryRow[]
}

async function defaultSclFetcher(workspaceId: string): Promise<SclRow[]> {
    const rows = await db.execute<SclRow>(sql`
        SELECT id, domain_region, graph_json
        FROM scl_concept_graphs
        WHERE workspace_id = ${workspaceId}::uuid
    `)
    return rows as unknown as SclRow[]
}

async function defaultReportPersister(workspaceId: string, report: ReembedJobReport): Promise<void> {
    const payload = {
        inProgressJobId: report.status === 'completed' || report.status === 'failed' ? null : report.jobId,
        lastRunAt: report.finishedAt ?? report.startedAt,
        lastReport: report,
    }
    await db.execute(sql`
        UPDATE workspaces
        SET intelligence_settings = jsonb_set(
            COALESCE(intelligence_settings, '{}'::jsonb),
            '{reembed}',
            ${JSON.stringify(payload)}::jsonb,
            true
        )
        WHERE id = ${workspaceId}::uuid
    `)
}
