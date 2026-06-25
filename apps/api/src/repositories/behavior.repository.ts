// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Agent-behavior-configuration data-access repository (Phase 5).
 *
 * owns the behavior_rules / behavior_snapshots reads and
 * writes behind the behavior routes. The route keeps validation, the
 * locked-rule guards, AGENTS.md import/export, and resolver orchestration.
 * Every query is workspace-scoped.
 */
import { eq, and, isNull, desc, or } from 'drizzle-orm'
import { db } from '@plexo/db'
import { behaviorRules, behaviorSnapshots } from '@plexo/db'

/**
 * Non-deleted rules for a workspace, oldest first. When projectId is set,
 * includes both workspace-level (null project) and that project's rules;
 * otherwise only workspace-level rules. `limit` undefined = no cap.
 */
export async function listRules(workspaceId: string, projectId: string | null, limit?: number) {
    const where = projectId
        ? and(
            eq(behaviorRules.workspaceId, workspaceId),
            isNull(behaviorRules.deletedAt),
            or(isNull(behaviorRules.projectId), eq(behaviorRules.projectId, projectId)),
        )
        : and(
            eq(behaviorRules.workspaceId, workspaceId),
            isNull(behaviorRules.projectId),
            isNull(behaviorRules.deletedAt),
        )
    const q = db.select().from(behaviorRules).where(where).orderBy(behaviorRules.createdAt)
    return limit !== undefined ? q.limit(limit) : q
}

/** Snapshot version history for a workspace, newest first. */
export async function listSnapshots(workspaceId: string, limit: number) {
    return db.select({
        id: behaviorSnapshots.id,
        workspaceId: behaviorSnapshots.workspaceId,
        projectId: behaviorSnapshots.projectId,
        compiledPrompt: behaviorSnapshots.compiledPrompt,
        triggeredBy: behaviorSnapshots.triggeredBy,
        triggerResourceId: behaviorSnapshots.triggerResourceId,
        createdAt: behaviorSnapshots.createdAt,
    }).from(behaviorSnapshots)
        .where(eq(behaviorSnapshots.workspaceId, workspaceId))
        .orderBy(desc(behaviorSnapshots.createdAt))
        .limit(limit)
}

/** Insert one rule, returning the created row. */
export async function insertRule(values: typeof behaviorRules.$inferInsert) {
    const [rule] = await db.insert(behaviorRules).values(values).returning()
    return rule
}

/** Insert many rules, returning the created rows. */
export async function insertRules(values: Array<typeof behaviorRules.$inferInsert>) {
    return db.insert(behaviorRules).values(values).returning()
}

/** A single rule scoped to its workspace, or undefined. */
export async function getRule(workspaceId: string, ruleId: string) {
    const [existing] = await db.select().from(behaviorRules).where(
        and(eq(behaviorRules.id, ruleId), eq(behaviorRules.workspaceId, workspaceId))
    ).limit(1)
    return existing
}

/** Apply a partial update to a rule by id, returning the updated row. */
export async function updateRule(ruleId: string, updates: Record<string, unknown>) {
    const [updated] = await db.update(behaviorRules)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .set(updates as any)
        .where(eq(behaviorRules.id, ruleId))
        .returning()
    return updated
}
