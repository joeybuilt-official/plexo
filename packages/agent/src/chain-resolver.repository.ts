// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the routing-chain resolver port (Stage 3). The only
 * chain-resolver module permitted to import the ORM. The SQL is unchanged from
 * the previous in-line query in `providers/chain-resolver.ts`; the driver-shape
 * normalization that used to live there moved here.
 */

import { db } from '@plexo/db'
import { sql } from 'drizzle-orm'
import type { ChainResolverStore, WorkspaceChainRow } from './chain-resolver.ports.js'

/** Normalize a drizzle `db.execute` result to its rows, across driver shapes. */
function dbRows<T>(result: unknown): T[] {
    if (result !== null && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows: unknown }).rows)) {
        return (result as { rows: T[] }).rows
    }
    return Array.isArray(result) ? (result as T[]) : []
}

interface ChainSqlRow {
    id: string
    task_type: string
    provider_id: string
    provider_type: string | null
    model_id: string
    position: number
}

export class DrizzleChainResolverStore implements ChainResolverStore {
    async loadWorkspaceChains(workspaceId: string): Promise<WorkspaceChainRow[]> {
        const result = await db.execute(sql`
            SELECT
                rc.id,
                rc.task_type,
                rc.provider_id,
                rc.model_id,
                rc.position,
                pi.provider_type
            FROM routing_chains rc
            LEFT JOIN provider_instances pi ON pi.id = rc.provider_id
            WHERE rc.workspace_id = ${workspaceId}::uuid
            ORDER BY rc.task_type, rc.position
        `)
        return dbRows<ChainSqlRow>(result).map(row => ({
            id: String(row.id),
            taskType: String(row.task_type),
            providerId: String(row.provider_id),
            providerType: row.provider_type === null || row.provider_type === undefined ? null : String(row.provider_type),
            modelId: String(row.model_id),
            position: Number(row.position),
        }))
    }
}
