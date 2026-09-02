// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the behavior resolution port (Stage 2). The only
 * behavior-area module permitted to import the ORM.
 */

import { db, behaviorRules, behaviorSnapshots } from '@plexo/db'
import { eq, and, isNull } from 'drizzle-orm'
import type { BehaviorRule, RuleValue } from './behavior/types.js'
import type { BehaviorResolutionStore, BehaviorSnapshotInsert } from './behavior.ports.js'

export class DrizzleBehaviorResolutionStore implements BehaviorResolutionStore {
    async listWorkspaceRules(workspaceId: string): Promise<BehaviorRule[]> {
        const rows = await db.select().from(behaviorRules)
            .where(and(
                eq(behaviorRules.workspaceId, workspaceId),
                isNull(behaviorRules.projectId),
                isNull(behaviorRules.deletedAt),
            ))
            .limit(500)
        return rows.map(r => ({ ...r, value: r.value as RuleValue }))
    }

    async listProjectRules(workspaceId: string, projectId: string): Promise<BehaviorRule[]> {
        const rows = await db.select().from(behaviorRules)
            .where(and(
                eq(behaviorRules.workspaceId, workspaceId),
                eq(behaviorRules.projectId, projectId),
                isNull(behaviorRules.deletedAt),
            ))
            .limit(500)
        return rows.map(r => ({ ...r, value: r.value as RuleValue }))
    }

    async insertSnapshot(input: BehaviorSnapshotInsert): Promise<void> {
        await db.insert(behaviorSnapshots).values({
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            snapshot: input.snapshot,
            compiledPrompt: input.compiledPrompt,
            triggeredBy: input.triggeredBy,
            triggerResourceId: input.triggerResourceId,
        })
    }
}
