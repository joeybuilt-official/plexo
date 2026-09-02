// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapters for the `tasks/` persistence ports (Stage 2). The only
 * `tasks`-area modules permitted to import the ORM.
 */

import { db, artifactShares, tasks } from '@plexo/db'
import { eq, and, isNull } from 'drizzle-orm'
import type {
    ArtifactShareStore,
    ArtifactShareInsert,
    TaskFailStore,
    MarkTaskFailedFields,
    MarkTaskFailedOutcome,
} from './tasks.ports.js'

export class DrizzleArtifactShareStore implements ArtifactShareStore {
    async findActiveShareId(artifactId: string): Promise<string | null> {
        const rows = await db.select({ id: artifactShares.id })
            .from(artifactShares)
            .where(and(eq(artifactShares.artifactId, artifactId), isNull(artifactShares.revokedAt)))
            .limit(1)
        return rows[0]?.id ?? null
    }

    async insertShareIfAbsent(share: ArtifactShareInsert): Promise<void> {
        await db.insert(artifactShares).values(share).onConflictDoNothing()
    }
}

export class DrizzleTaskFailStore implements TaskFailStore {
    async markFailed(fields: MarkTaskFailedFields): Promise<MarkTaskFailedOutcome> {
        const whereClause = fields.requireFromStatus
            ? and(eq(tasks.id, fields.taskId), eq(tasks.status, fields.requireFromStatus))
            : eq(tasks.id, fields.taskId)

        const updated = await db.update(tasks)
            .set({
                status: 'failed',
                failedAt: new Date(),
                failureReason: fields.failureReason,
                outcomeSummary: fields.outcomeSummary,
                claimedAt: null,
                claimedUntil: null,
            })
            .where(whereClause)
            .returning({ id: tasks.id, parentId: tasks.parentId })

        return {
            transitioned: updated.length > 0,
            parentTaskId: updated[0]?.parentId ?? null,
        }
    }
}
