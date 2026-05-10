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
const batchSize = Number(process.argv.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? 50)
const delayMs = Number(process.argv.find((a) => a.startsWith('--delay-ms='))?.split('=')[1] ?? 100)

if (!allWorkspaces && !SINGLE_WORKSPACE) {
    console.error('FAIL: pass WORKSPACE_ID or --all')
    process.exit(2)
}

const client = new GraphitiClient({ baseUrl: SIDECAR_URL, serviceKey: SERVICE_KEY, appId: 'corpus-migrate' })

async function ensureMigrationLog(): Promise<void> {
    await db.execute(sql`
        CREATE TABLE IF NOT EXISTS corpus_migration_log (
            workspace_id UUID PRIMARY KEY,
            last_memory_id UUID,
            episodes_migrated INTEGER NOT NULL DEFAULT 0,
            errors_encountered INTEGER NOT NULL DEFAULT 0,
            started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_at TIMESTAMPTZ
        )
    `)
}

interface LogRow extends Record<string, unknown> {
    workspace_id: string
    last_memory_id: string | null
    episodes_migrated: number
    errors_encountered: number
    completed_at: string | null
}

async function getLog(workspaceId: string): Promise<LogRow | null> {
    const r = await db.execute<LogRow>(sql`
        SELECT workspace_id::text AS workspace_id, last_memory_id::text AS last_memory_id,
               episodes_migrated, errors_encountered, completed_at::text AS completed_at
        FROM corpus_migration_log WHERE workspace_id = ${workspaceId}::uuid
    `)
    const rows = Array.isArray(r) ? (r as LogRow[]) : ((r as { rows?: LogRow[] }).rows ?? [])
    return rows[0] ?? null
}

async function upsertLog(workspaceId: string, lastMemoryId: string | null, episodes: number, errors: number, done: boolean): Promise<void> {
    await db.execute(sql`
        INSERT INTO corpus_migration_log (workspace_id, last_memory_id, episodes_migrated, errors_encountered, completed_at)
        VALUES (${workspaceId}::uuid, ${lastMemoryId ? sql`${lastMemoryId}::uuid` : sql`NULL`}, ${episodes}, ${errors}, ${done ? sql`NOW()` : sql`NULL`})
        ON CONFLICT (workspace_id) DO UPDATE
            SET last_memory_id = EXCLUDED.last_memory_id,
                episodes_migrated = corpus_migration_log.episodes_migrated + EXCLUDED.episodes_migrated,
                errors_encountered = corpus_migration_log.errors_encountered + EXCLUDED.errors_encountered,
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

async function migrateWorkspace(workspaceId: string): Promise<{ migrated: number; errors: number }> {
    const log = resume ? await getLog(workspaceId) : null
    const cursorClause = log?.last_memory_id ? sql`AND id > ${log.last_memory_id}::uuid` : sql``

    let totalMigrated = 0
    let totalErrors = 0
    let lastId: string | null = log?.last_memory_id ?? null

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const lastIdClause = lastId ? sql`AND id > ${lastId}::uuid` : cursorClause
        const r = await db.execute<MemoryRow>(sql`
            SELECT id::text AS id, workspace_id::text AS workspace_id, type, content,
                   subject, predicate, object, fact_type, domain, source, namespace,
                   created_at::text AS created_at
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND superseded_by IS NULL
              AND (invalid_at IS NULL OR invalid_at > NOW())
              ${lastIdClause}
            ORDER BY id ASC
            LIMIT ${batchSize}
        `)
        const batch = Array.isArray(r) ? (r as MemoryRow[]) : ((r as { rows?: MemoryRow[] }).rows ?? [])
        if (batch.length === 0) break

        for (const row of batch) {
            if (dryRun) {
                totalMigrated++
                lastId = row.id
                continue
            }
            const triple = row.subject && row.predicate && row.object
                ? { subject: row.subject, predicate: row.predicate, object: row.object }
                : undefined
            const result = await client.addEpisode({
                workspaceId,
                content: row.content,
                name: `corpus-${row.id.slice(0, 8)}`,
                sourceDescription: `app:plexo|src:corpus-migrate|orig_type:${row.type}`,
                episodeType: 'message',
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
            })
            if (!result) {
                totalErrors++
                console.error(`  ERROR: bridge.addEpisode returned null for ${row.id}`)
            } else {
                totalMigrated++
            }
            lastId = row.id
            if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs))
        }

        if (!dryRun) await upsertLog(workspaceId, lastId, batch.length - totalErrors, totalErrors, false)
        console.log(`  ${workspaceId}: batch ${batch.length} → migrated=${totalMigrated} errors=${totalErrors}`)
    }

    if (!dryRun) await upsertLog(workspaceId, lastId, 0, 0, true)
    return { migrated: totalMigrated, errors: totalErrors }
}

async function main(): Promise<void> {
    if (!dryRun) await ensureMigrationLog()
    const workspaces = await listWorkspaces()
    console.log(`migrate-corpus: ${workspaces.length} workspace(s) ${dryRun ? '(DRY-RUN)' : ''}`)

    let totalMig = 0
    let totalErr = 0
    for (const ws of workspaces) {
        console.log(`\n=== workspace ${ws} ===`)
        const r = await migrateWorkspace(ws)
        totalMig += r.migrated
        totalErr += r.errors
    }

    console.log(`\nDONE: migrated=${totalMig} errors=${totalErr}${dryRun ? ' (DRY-RUN — nothing written)' : ''}`)
    if (totalErr > 0) process.exit(1)
}

main().catch((err) => {
    console.error('FATAL:', err)
    process.exit(2)
})
