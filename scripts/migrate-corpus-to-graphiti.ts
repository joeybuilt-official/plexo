#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 7 of `graphiti-migration/plan.md` — replay existing memory_entries
 * rows into the Graphiti sidecar.
 *
 * MANUAL OPERATION — do NOT run automatically.
 *
 * Operator prerequisites (from plan + checklist):
 *   1. Phase 5 dual-write is observed clean for ≥7 days in prod.
 *   2. Phase 6 read-path is live (MEMORY_READ_BACKEND=graphiti).
 *   3. `pg_dump memory_entries` to off-VPS storage. Verified.
 *   4. Dry-run on a copy of prod-shaped data. Operator gate signed off.
 *
 * Idempotency: a `corpus_migration_log` table — created at runtime via
 * `CREATE TABLE IF NOT EXISTS` so this script doesn't need a drizzle
 * migration journal entry — tracks per-workspace progress
 * (last_memory_id, completed_at). Re-running on a partially-migrated
 * workspace resumes from the last recorded id; no duplicate episodes.
 *
 * Bypass note: the plan's "add_fact_triple" reference is to an API that
 * doesn't exist in graphiti-core 0.29 — the actual upstream method is
 * `add_triplet(EntityNode, EntityEdge, EntityNode)`. This script does
 * NOT use that bypass; every row replays via `add_episode` (paying the
 * per-write LLM extraction cost) so embedding + dedup semantics are
 * the documented Graphiti defaults. If prod-scale cost forces it, the
 * bypass endpoint can be added later (Phase 7.x) — that's a sidecar
 * change + bridge addFactTriple wrapper, separate from this script.
 *
 * Usage:
 *   PLEXO_GRAPHITI_SIDECAR_URL=http://127.0.0.1:8090 \
 *   PLEXO_SERVICE_KEY=<...> \
 *   WORKSPACE_ID=<uuid> \
 *   pnpm tsx scripts/migrate-corpus-to-graphiti.ts
 *
 * Options:
 *   --dry-run         Report row counts; do not call the bridge
 *   --batch=N         Episodes per workspace_id batch (default 50)
 *   --delay-ms=MS     Pause between bridge calls (default 100)
 *   --all             Migrate every workspace (default: only WORKSPACE_ID)
 *   --resume          Resume from corpus_migration_log; skip already-done rows
 *   --retry-failed    Process the durable failed_ids queue first; rows that
 *                     succeed on retry are removed from the queue. Use with
 *                     --resume after a transient sidecar/embedder outage.
 *   --limit=N         Process at most N rows per workspace this run; useful
 *                     for sample/sanity runs before committing to the full
 *                     multi-day migration.
 *   --timeout-ms=MS   Max time per addEpisode HTTP call (default 90_000).
 *                     A bound is required because graphiti-core's
 *                     add_episode can deadlock internally on Kuzu WAL
 *                     issues. Hung calls are recorded in failed_ids and
 *                     the cursor advances so the migration keeps moving.
 *
 * Failure handling:
 *   Each addEpisode failure is appended to corpus_migration_log.failed_ids
 *   and the cursor still advances (so a transient sidecar blip doesn't stall
 *   forward progress). Re-run with `--resume --retry-failed` to drain the
 *   queue once the sidecar/embedder is healthy again.
 */

import { db, sql } from '@plexo/db'
import { GraphitiClient } from '@plexo/graphiti-bridge'

const SIDECAR_URL = process.env.PLEXO_GRAPHITI_SIDECAR_URL
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY
const SINGLE_WORKSPACE = process.env.WORKSPACE_ID

if (!SIDECAR_URL || !SERVICE_KEY) {
    console.error('FAIL: PLEXO_GRAPHITI_SIDECAR_URL + PLEXO_SERVICE_KEY env vars required')
    process.exit(2)
}

const dryRun = process.argv.includes('--dry-run')
const allWorkspaces = process.argv.includes('--all')
const resume = process.argv.includes('--resume')
const retryFailed = process.argv.includes('--retry-failed')
const batchSize = Number(process.argv.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? 50)
const delayMs = Number(process.argv.find((a) => a.startsWith('--delay-ms='))?.split('=')[1] ?? 100)
const limit = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 0)
const requestTimeoutMs = Number(process.argv.find((a) => a.startsWith('--timeout-ms='))?.split('=')[1] ?? 90_000)
const typesFilterRaw = process.argv.find((a) => a.startsWith('--types='))?.split('=')[1] ?? null
const typesFilter: string[] | null = typesFilterRaw ? typesFilterRaw.split(',').map((s) => s.trim()).filter(Boolean) : null
const ALLOWED_TYPES = new Set(['task', 'pattern', 'session', 'note'])
if (typesFilter) {
    for (const t of typesFilter) {
        if (!ALLOWED_TYPES.has(t)) {
            console.error(`FAIL: --types contains unknown type "${t}" (allowed: ${Array.from(ALLOWED_TYPES).join(', ')})`)
            process.exit(2)
        }
    }
}

if (!allWorkspaces && !SINGLE_WORKSPACE) {
    console.error('FAIL: pass WORKSPACE_ID or --all')
    process.exit(2)
}

// stdout is line-buffered when piped (e.g., nohup ... > /var/log/...);
// force flush after each write so live tail of the log file reflects the
// migrator's true position. Without this, progress lines stay in the pipe
// buffer and don't appear in the log until the buffer fills, masking
// progress and complicating "is it hung?" diagnostics.
if (process.stdout && typeof (process.stdout as { _handle?: { setBlocking?: (b: boolean) => void } })._handle?.setBlocking === 'function') {
    ;(process.stdout as { _handle: { setBlocking: (b: boolean) => void } })._handle.setBlocking(true)
}

// Hard timeout per HTTP request to the sidecar. graphiti-core's add_episode
// can deadlock internally when Kuzu's WAL accumulates without checkpointing
// (observed 2026-05-10 — first run hung after ~50 episodes, never produced
// any post-batch upsertLog write because the fetch was stuck awaiting a
// response that never came). AbortController bounds each call so a hung
// addEpisode lands in the failed_ids queue instead of stalling the
// migration indefinitely.
const fetchWithTimeout: typeof fetch = async (input, init) => {
    const ac = new AbortController()
    const id = setTimeout(() => ac.abort(), requestTimeoutMs)
    try {
        return await fetch(input, { ...(init ?? {}), signal: ac.signal })
    } finally {
        clearTimeout(id)
    }
}

const client = new GraphitiClient({ baseUrl: SIDECAR_URL, serviceKey: SERVICE_KEY, appId: 'corpus-migrate', fetchImpl: fetchWithTimeout })

async function ensureMigrationLog(): Promise<void> {
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS corpus_migration_log (
            workspace_id UUID PRIMARY KEY,
            last_memory_id UUID,
            episodes_migrated INTEGER NOT NULL DEFAULT 0,
            errors_encountered INTEGER NOT NULL DEFAULT 0,
            failed_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
    `)
    // Backfill column on pre-existing tables (no-op if already present).
    await db.execute(sql`
        ALTER TABLE corpus_migration_log
            ADD COLUMN IF NOT EXISTS failed_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[]
    `)
}

interface LogRow extends Record<string, unknown> {
    workspace_id: string
    last_memory_id: string | null
    episodes_migrated: number
    errors_encountered: number
    failed_ids: string[]
    completed_at: string | null
}

async function getLog(workspaceId: string): Promise<LogRow | null> {
    const r = await db.execute<LogRow>(sql`
        SELECT workspace_id::text AS workspace_id, last_memory_id::text AS last_memory_id,
               episodes_migrated, errors_encountered,
               COALESCE(failed_ids, ARRAY[]::UUID[])::text[] AS failed_ids,
               completed_at::text AS completed_at
        FROM corpus_migration_log WHERE workspace_id = ${workspaceId}::uuid
    `)
    const rows = Array.isArray(r) ? (r as LogRow[]) : ((r as { rows?: LogRow[] }).rows ?? [])
    return rows[0] ?? null
}

// Writes ABSOLUTE totals — no increment math. Caller passes the running totals
// (loaded from the prior log row on resume, or zero on a fresh start) so that
// retried/duplicate batches can never double-count.
async function upsertLog(
    workspaceId: string,
    lastMemoryId: string | null,
    totalMigrated: number,
    totalErrors: number,
    failedIds: string[],
    done: boolean,
): Promise<void> {
    const failedLiteral = failedIds.length === 0
        ? sql`ARRAY[]::UUID[]`
        : sql.raw(`ARRAY[${failedIds.map((id) => `'${id}'::uuid`).join(',')}]`)
    await db.execute(sql`
        INSERT INTO corpus_migration_log (workspace_id, last_memory_id, episodes_migrated, errors_encountered, failed_ids, completed_at)
        VALUES (${workspaceId}::uuid, ${lastMemoryId ? sql`${lastMemoryId}::uuid` : sql`NULL`}, ${totalMigrated}, ${totalErrors}, ${failedLiteral}, ${done ? sql`NOW()` : sql`NULL`})
        ON CONFLICT (workspace_id) DO UPDATE
            SET last_memory_id = EXCLUDED.last_memory_id,
                episodes_migrated = EXCLUDED.episodes_migrated,
                errors_encountered = EXCLUDED.errors_encountered,
                failed_ids = EXCLUDED.failed_ids,
                updated_at = NOW(),
                completed_at = COALESCE(EXCLUDED.completed_at, corpus_migration_log.completed_at)
    `)
}

interface MemoryRow extends Record<string, unknown> {
    id: string
    workspace_id: string
    type: string
    content: string
    subject: string | null
    predicate: string | null
    object: string | null
    fact_type: string | null
    domain: string | null
    source: string | null
    namespace: string
    created_at: string
}

async function listWorkspaces(): Promise<string[]> {
    if (SINGLE_WORKSPACE && !allWorkspaces) return [SINGLE_WORKSPACE]
    const r = await db.execute<{ workspace_id: string }>(sql`
        SELECT DISTINCT workspace_id::text AS workspace_id FROM memory_entries
    `)
    const rows = Array.isArray(r) ? (r as Array<{ workspace_id: string }>) : ((r as { rows?: Array<{ workspace_id: string }> }).rows ?? [])
    return rows.map((row) => row.workspace_id)
}

function rowToEpisode(row: MemoryRow) {
    const triple = row.subject && row.predicate && row.object
        ? { subject: row.subject, predicate: row.predicate, object: row.object }
        : undefined
    return {
        workspaceId: row.workspace_id,
        content: row.content,
        name: `corpus-${row.id.slice(0, 8)}`,
        sourceDescription: `app:plexo|src:corpus-migrate|orig_type:${row.type}`,
        episodeType: 'message' as const,
        referenceTime: row.created_at,
        triple,
        sourceMetadata: {
            plexo_memory_id: row.id,
            fact_type: row.fact_type ?? null,
            domain: row.domain ?? null,
            source: row.source ?? null,
            namespace: row.namespace,
            orig_type: row.type,
        },
    }
}

async function migrateWorkspace(workspaceId: string): Promise<{ migrated: number; errors: number; failed: number }> {
    const log = resume ? await getLog(workspaceId) : null
    let lastId: string | null = log?.last_memory_id ?? null
    // Cumulative across runs — preserves prior progress on resume so the DB
    // counter reflects total work done across migrator invocations. Sanitize
    // negatives left over from the pre-fix increment-math bug.
    let totalMigrated = Math.max(0, log?.episodes_migrated ?? 0)
    let totalErrors = Math.max(0, log?.errors_encountered ?? 0)
    const failedSet = new Set<string>(log?.failed_ids ?? [])

    let processedThisRun = 0

    // Phase A: retry previously-failed rows when --retry-failed is set.
    if (resume && retryFailed && failedSet.size > 0) {
        const ids = Array.from(failedSet)
        console.log(`  ${workspaceId}: retrying ${ids.length} previously-failed row(s)`)
        for (let i = 0; i < ids.length; i += batchSize) {
            const slice = ids.slice(i, i + batchSize)
            const inLiteral = sql.raw(`(${slice.map((id) => `'${id}'::uuid`).join(',')})`)
            const r = await db.execute<MemoryRow>(sql`
                SELECT id::text AS id, workspace_id::text AS workspace_id, type, content,
                       subject, predicate, object, fact_type, domain, source, namespace,
                       created_at::text AS created_at
                FROM memory_entries
                WHERE id IN ${inLiteral}
            `)
            const batch = Array.isArray(r) ? (r as MemoryRow[]) : ((r as { rows?: MemoryRow[] }).rows ?? [])
            for (const row of batch) {
                if (dryRun) {
                    failedSet.delete(row.id)
                    processedThisRun++
                    if (limit > 0 && processedThisRun >= limit) break
                    continue
                }
                const result = await client.addEpisode(rowToEpisode(row))
                if (result) {
                    failedSet.delete(row.id)
                    totalMigrated++
                    if (totalErrors > 0) totalErrors-- // recover one prior error
                } else {
                    console.error(`  ERROR: retry returned null for ${row.id}`)
                }
                processedThisRun++
                if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs))
                if (limit > 0 && processedThisRun >= limit) break
            }
            if (!dryRun) await upsertLog(workspaceId, lastId, totalMigrated, totalErrors, Array.from(failedSet), false)
            console.log(`  ${workspaceId}: retry-batch ${batch.length} → remaining-failed=${failedSet.size}`)
            if (limit > 0 && processedThisRun >= limit) break
        }
    }

    // Phase B: cursor-based forward migration.
    while (limit === 0 || processedThisRun < limit) {
        const lastIdClause = lastId ? sql`AND id > ${lastId}::uuid` : sql``
        const typesClause = typesFilter && typesFilter.length > 0
            ? sql`AND type IN ${sql.raw(`(${typesFilter.map((t) => `'${t}'`).join(',')})`)}`
            : sql``
        const r = await db.execute<MemoryRow>(sql`
            SELECT id::text AS id, workspace_id::text AS workspace_id, type, content,
                   subject, predicate, object, fact_type, domain, source, namespace,
                   created_at::text AS created_at
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND superseded_by IS NULL
              AND (invalid_at IS NULL OR invalid_at > NOW())
              ${lastIdClause}
              ${typesClause}
            ORDER BY id ASC
            LIMIT ${batchSize}
        `)
        const batch = Array.isArray(r) ? (r as MemoryRow[]) : ((r as { rows?: MemoryRow[] }).rows ?? [])
        if (batch.length === 0) break

        let perBatchOk = 0
        let perBatchErr = 0
        for (const row of batch) {
            if (dryRun) {
                perBatchOk++
                lastId = row.id
                processedThisRun++
                if (limit > 0 && processedThisRun >= limit) break
                continue
            }
            const t0 = Date.now()
            const result = await client.addEpisode(rowToEpisode(row))
            const elapsedMs = Date.now() - t0
            if (!result) {
                perBatchErr++
                totalErrors++
                failedSet.add(row.id)
                console.log(`  ${workspaceId} row ${processedThisRun + 1}: ERR ${row.id} (${elapsedMs}ms)`)
            } else {
                perBatchOk++
                totalMigrated++
                console.log(`  ${workspaceId} row ${processedThisRun + 1}: ok ${row.id} (${elapsedMs}ms) facts=${result.extractedFactsCount} nodes=${result.extractedNodesCount}`)
            }
            // Cursor advances always — failures are tracked in failedSet for
            // durable retry via --retry-failed.
            lastId = row.id
            processedThisRun++
            // Per-row durability — if the next addEpisode hangs and we get
            // killed, progress through this row is committed.
            await upsertLog(workspaceId, lastId, totalMigrated, totalErrors, Array.from(failedSet), false)
            if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs))
            if (limit > 0 && processedThisRun >= limit) break
        }

        console.log(`  ${workspaceId}: batch summary ${batch.length} → ok=${perBatchOk} err=${perBatchErr} cumOk=${totalMigrated} cumErr=${totalErrors} failedQueue=${failedSet.size}`)
    }

    const done = limit === 0 && failedSet.size === 0
    if (!dryRun) await upsertLog(workspaceId, lastId, totalMigrated, totalErrors, Array.from(failedSet), done)
    return { migrated: totalMigrated, errors: totalErrors, failed: failedSet.size }
}

async function main(): Promise<void> {
    if (!dryRun) await ensureMigrationLog()
    const workspaces = await listWorkspaces()
    console.log(`migrate-corpus: ${workspaces.length} workspace(s) ${dryRun ? '(DRY-RUN)' : ''}${limit > 0 ? ` (limit=${limit}/ws)` : ''}`)

    let totalMig = 0
    let totalErr = 0
    let totalFailed = 0
    for (const ws of workspaces) {
        console.log(`\n=== workspace ${ws} ===`)
        const r = await migrateWorkspace(ws)
        totalMig += r.migrated
        totalErr += r.errors
        totalFailed += r.failed
    }

    console.log(`\nDONE: cumMigrated=${totalMig} cumErrors=${totalErr} pendingFailedRetry=${totalFailed}${dryRun ? ' (DRY-RUN — nothing written)' : ''}`)
    // Exit non-zero only if there are failed rows still pending retry. Past
    // errors that have been recovered (via --retry-failed) shouldn't trigger
    // failure exit; the failed-queue size is the live signal.
    if (totalFailed > 0) process.exit(1)
}

main().catch((err) => {
    console.error('FATAL:', err)
    process.exit(2)
})
