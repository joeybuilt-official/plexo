// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Corpus migration introspection tool.
 *
 * Reads corpus_migration_log (created by graphiti-migration/) so the agent can
 * answer "how is the cutover going?" without shelling out to psql. Workspace-
 * scoped: each builder is bound to a single workspaceId and queries that
 * workspace's row only.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

type MigrationRow = {
    workspace_id: string
    episodes_migrated: number
    errors_encountered: number
    failed_pending: number
    started_at: string | null
    updated_at: string | null
    completed_at: string | null
} & Record<string, unknown>

export function buildMigrationTools(workspaceId: string) {
    return {
        get_corpus_migration_status: tool({
            description:
                'Check progress of the Graphiti corpus migration for the current workspace. '
                + 'Returns episodes_migrated, errors_encountered, failed_pending, started_at, '
                + 'updated_at, completed_at, and total memory_entries in the workspace so percent '
                + 'complete can be derived. Read-only.',
            inputSchema: z.object({}),
            execute: async () => {
                try {
                    const rows = await db.execute<MigrationRow>(sql`
                        SELECT
                            workspace_id::text                                          AS workspace_id,
                            episodes_migrated,
                            errors_encountered,
                            COALESCE(array_length(failed_ids, 1), 0)                    AS failed_pending,
                            started_at::text                                            AS started_at,
                            updated_at::text                                            AS updated_at,
                            completed_at::text                                          AS completed_at
                        FROM corpus_migration_log
                        WHERE workspace_id = ${workspaceId}::uuid
                        LIMIT 1
                    `)
                    if (rows.length === 0) {
                        return JSON.stringify({ found: false, workspaceId, note: 'No corpus_migration_log row for this workspace.' })
                    }
                    const totalRows = await db.execute<{ total: number }>(sql`
                        SELECT COUNT(*)::int AS total FROM memory_entries WHERE workspace_id = ${workspaceId}::uuid
                    `)
                    const total = totalRows[0]?.total ?? 0
                    const r = rows[0]!
                    const pct = total > 0 ? Math.round((r.episodes_migrated / total) * 10000) / 100 : null
                    return JSON.stringify({
                        found: true,
                        workspaceId,
                        episodesMigrated: r.episodes_migrated,
                        errorsEncountered: r.errors_encountered,
                        failedPending: r.failed_pending,
                        totalMemoryEntries: total,
                        percentComplete: pct,
                        startedAt: r.started_at,
                        updatedAt: r.updated_at,
                        completedAt: r.completed_at,
                        isComplete: r.completed_at !== null,
                    })
                } catch (err) {
                    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
                }
            },
        }),
    }
}
