// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Intelligence-settings data-access repository.
 *
 * owns the workspaces.intelligence_settings JSONB reads/
 * writes (inference-mode, cost-ceiling, step-budget) and the routing_chains
 * read + atomic-replace transaction behind the intelligence routes. The route
 * keeps validation, the IntelligenceSettings cast, pgRows row-shaping, cache
 * invalidation, and the agent chain-resolver bust.
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaces } from '@plexo/db'

/** Raw {s: intelligenceSettings} row for a workspace, or undefined. */
export async function getIntelligenceSettingsRow(workspaceId: string) {
    const [row] = await db.select({ s: workspaces.intelligenceSettings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1)
    return row
}

/** Set workspaces.intelligence_settings.inferenceMode. */
export async function setInferenceMode(workspaceId: string, modeJson: string): Promise<void> {
    await db.execute(sql`
        UPDATE workspaces
        SET intelligence_settings = jsonb_set(
            COALESCE(intelligence_settings, '{}'::jsonb),
            '{inferenceMode}',
            ${modeJson}::jsonb,
            true
        )
        WHERE id = ${workspaceId}::uuid
    `)
}

/** Set both costCeilingUsd + costCeilingMode in one jsonb_set chain. */
export async function setCostCeilingWithMode(workspaceId: string, ceilingJson: string, modeJson: string): Promise<void> {
    await db.execute(sql`
        UPDATE workspaces
        SET intelligence_settings = jsonb_set(
            jsonb_set(
                COALESCE(intelligence_settings, '{}'::jsonb),
                '{costCeilingUsd}',
                ${ceilingJson}::jsonb,
                true
            ),
            '{costCeilingMode}',
            ${modeJson}::jsonb,
            true
        )
        WHERE id = ${workspaceId}::uuid
    `)
}

/** Set costCeilingUsd only. */
export async function setCostCeiling(workspaceId: string, ceilingJson: string): Promise<void> {
    await db.execute(sql`
        UPDATE workspaces
        SET intelligence_settings = jsonb_set(
            COALESCE(intelligence_settings, '{}'::jsonb),
            '{costCeilingUsd}',
            ${ceilingJson}::jsonb,
            true
        )
        WHERE id = ${workspaceId}::uuid
    `)
}

/** Set workspaces.intelligence_settings.stepBudget. */
export async function setStepBudget(workspaceId: string, budgetJson: string): Promise<void> {
    await db.execute(sql`
        UPDATE workspaces
        SET intelligence_settings = jsonb_set(
            COALESCE(intelligence_settings, '{}'::jsonb),
            '{stepBudget}',
            ${budgetJson}::jsonb,
            true
        )
        WHERE id = ${workspaceId}::uuid
    `)
}

/** Raw routing_chains rows for a workspace, ordered by task_type, position. */
export async function selectChainsForWorkspace(workspaceId: string) {
    return db.execute(sql`
        SELECT id, task_type, provider_id, model_id, position
        FROM routing_chains
        WHERE workspace_id = ${workspaceId}::uuid
        ORDER BY task_type, position
    `)
}

/** Atomically replace a task-type's routing chain (delete + re-insert in a tx). */
export async function replaceChain(
    workspaceId: string,
    taskType: string,
    entries: Array<{ providerId: string; modelId: string }>,
): Promise<void> {
    await db.transaction(async (tx) => {
        await tx.execute(sql`
            DELETE FROM routing_chains
            WHERE workspace_id = ${workspaceId}::uuid AND task_type = ${taskType}
        `)
        let position = 0
        for (const entry of entries) {
            await tx.execute(sql`
                INSERT INTO routing_chains (workspace_id, task_type, provider_id, model_id, position)
                VALUES (
                    ${workspaceId}::uuid,
                    ${taskType},
                    ${entry.providerId}::uuid,
                    ${entry.modelId},
                    ${position}
                )
            `)
            position += 1
        }
    })
}
