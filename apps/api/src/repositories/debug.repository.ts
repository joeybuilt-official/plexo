// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Debug-snapshot data-access repository (read-only).
 *
 * arch-findings B1 — owns the admin debug stat queries (task queue, sprint
 * tasks, work ledger, improvement log). The route keeps the x-debug-token
 * gate, RPC allowlisting, and numeric post-processing.
 */
import { db, sql } from '@plexo/db'

/** Task queue counts (running / queued / total). */
export async function getQueueStats(): Promise<Array<{ running: string; queued: string; total: string }>> {
    return db.execute<{ running: string; queued: string; total: string }>(sql`
        SELECT
            COUNT(*) FILTER (WHERE status = 'running') AS running,
            COUNT(*) FILTER (WHERE status = 'queued')  AS queued,
            COUNT(*)                                   AS total
        FROM tasks
    `)
}

/** Sprint-task counts (pending / in_progress / total). */
export async function getSprintTaskStats(): Promise<Array<{ pending: string; in_progress: string; total: string }>> {
    return db.execute<{ pending: string; in_progress: string; total: string }>(sql`
        SELECT
            COUNT(*) FILTER (WHERE status = 'queued')   AS pending,
            COUNT(*) FILTER (WHERE status = 'running')  AS in_progress,
            COUNT(*)                                    AS total
        FROM sprint_tasks
    `)
}

/** Trailing-7d work-ledger rollup. */
export async function getLedger7dStats(): Promise<Array<{ rows: string; avg_quality: string | null; total_tokens: string }>> {
    return db.execute<{ rows: string; avg_quality: string | null; total_tokens: string }>(sql`
        SELECT
            COUNT(*)            AS rows,
            AVG(quality_score)  AS avg_quality,
            SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS total_tokens
        FROM work_ledger
        WHERE completed_at > NOW() - INTERVAL '7 days'
    `)
}

/** Running/queued task counts (queue.stats RPC). */
export async function getQueueRunningQueued(): Promise<Array<{ running: string; queued: string }>> {
    return db.execute<{ running: string; queued: string }>(sql`
        SELECT
            COUNT(*) FILTER (WHERE status = 'running') AS running,
            COUNT(*) FILTER (WHERE status = 'queued')  AS queued
        FROM tasks
    `)
}

/** Recent agent improvement-log entries (memory.list RPC). */
export async function listImprovements(): Promise<Array<{ id: string; pattern_type: string; description: string; created_at: Date }>> {
    return db.execute<{ id: string; pattern_type: string; description: string; created_at: Date }>(sql`
        SELECT id, pattern_type, description, created_at
        FROM agent_improvement_log
        ORDER BY created_at DESC
        LIMIT 10
    `)
}
