// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Telegram-adapter data-access repository.
 *
 * owns the telegram-specific read queries (memory heatmap).
 * Sprint/channel/workspace queries the adapter shares live in their own repos.
 * The route keeps Telegram API I/O, command parsing, and message formatting.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

export interface MemoryHeatmapRow {
    tier: string
    confidence_band: string
    count: number
    last_decay_at: string | null
}

/** Per-tier / confidence-band memory counts for a workspace (/memoryheatmap). */
export async function getMemoryHeatmap(workspaceId: string): Promise<MemoryHeatmapRow[]> {
    return db.execute<MemoryHeatmapRow>(sql`
        SELECT tier, confidence_band, count, last_decay_at
        FROM memory_tier_stats
        WHERE workspace_id = ${workspaceId}::uuid
        ORDER BY tier, confidence_band
    `)
}
