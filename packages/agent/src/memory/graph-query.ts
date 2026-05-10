// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0009 — concept graph layer (replaces SCL/MindsetObject).
 *
 * Three operations against concept_nodes / concept_edges / concept_membership:
 *  - graphMutate    upsert nodes + membership; light edge inference
 *  - graphExpand    recursive CTE BFS from a stimulus; depth/width caps + truncated flag
 *  - getGraphMeta   per-workspace counts + last update
 *  - triggerGraphExtract heartbeat (real linker runs in extract-worker)
 *
 * Caps mirror Wave B's expander (ADR 0009 pre-mortem #3): default depth 2,
 * default width 50, max depth 4, max width 200, statement_timeout 2s.
 */

import pino from 'pino'
import { db, sql } from '@plexo/db'
import { embed } from './store.js'
import type { WorkspaceAISettings } from '../providers/registry.js'

const logger = pino({ name: 'memory:graph' })

export const DEFAULT_DEPTH = 2
export const MAX_DEPTH = 4
export const DEFAULT_WIDTH = 50
export const MAX_WIDTH = 200
export const STATEMENT_TIMEOUT_MS = 2000
export const EDGE_INFERENCE_THRESHOLD = 0.85
export const EDGE_INFERENCE_CAP = 5

export interface ConceptInput {
    label: string
    type?: string
}

export interface ExpandedNode {
    id: string
    label: string
    type: string | null
    depth: number
}

export interface ExpandResult {
    nodes: ExpandedNode[]
    truncated: boolean
}

export interface GraphMeta {
    nodeCount: number
    edgeCount: number
    lastUpdate: Date | null
}

interface MutateRow {
    id: string
    created: boolean
    [key: string]: unknown
}

/**
 * Upsert concept nodes by (workspace_id, label). For each new node, link
 * membership to the source memory entry (if provided) and run light edge
 * inference: insert up to EDGE_INFERENCE_CAP edges to existing nodes within
 * EDGE_INFERENCE_THRESHOLD cosine. Existing nodes only bump updated_at.
 */
export async function graphMutate(params: {
    workspaceId: string
    concepts: ConceptInput[]
    source: string
    memoryEntryId?: string
    aiSettings?: WorkspaceAISettings
}): Promise<{ nodeIds: string[]; created: number; existing: number }> {
    const { workspaceId, concepts, source, memoryEntryId, aiSettings } = params
    if (concepts.length === 0) return { nodeIds: [], created: 0, existing: 0 }

    const nodeIds: string[] = []
    let created = 0
    let existing = 0

    for (const concept of concepts) {
        const vector = await embed(concept.label, workspaceId, aiSettings).catch((err: unknown) => {
            logger.warn({ err, workspaceId, label: concept.label }, 'graphMutate: embed failed for concept')
            return null
        })
        if (!vector) continue

        const vecStr = `[${vector.join(',')}]`

        const rows = await db.execute<MutateRow>(sql`
            INSERT INTO concept_nodes (workspace_id, label, type, embedding)
            VALUES (
                ${workspaceId}::uuid,
                ${concept.label},
                ${concept.type ?? null},
                ${vecStr}::vector
            )
            ON CONFLICT (workspace_id, label) DO UPDATE
                SET updated_at = NOW(),
                    type = COALESCE(concept_nodes.type, EXCLUDED.type)
            RETURNING id, (xmax = 0) AS created
        `)
        const row = rows[0]
        if (!row) continue

        nodeIds.push(row.id)
        if (row.created) created++
        else existing++

        if (memoryEntryId) {
            await db.execute(sql`
                INSERT INTO concept_membership (workspace_id, memory_entry_id, concept_node_id, weight)
                VALUES (${workspaceId}::uuid, ${memoryEntryId}::uuid, ${row.id}::uuid, 1.0)
                ON CONFLICT DO NOTHING
            `)
        }

        if (row.created) {
            await db.execute(sql`
                INSERT INTO concept_edges (workspace_id, src_node_id, dst_node_id, relation, weight)
                SELECT
                    ${workspaceId}::uuid,
                    ${row.id}::uuid,
                    n.id,
                    'similar',
                    (1 - (n.embedding <=> ${vecStr}::vector))::real
                FROM concept_nodes n
                WHERE n.workspace_id = ${workspaceId}::uuid
                  AND n.id <> ${row.id}::uuid
                  AND n.embedding IS NOT NULL
                  AND (1 - (n.embedding <=> ${vecStr}::vector)) >= ${EDGE_INFERENCE_THRESHOLD}
                ORDER BY n.embedding <=> ${vecStr}::vector
                LIMIT ${EDGE_INFERENCE_CAP}
                ON CONFLICT DO NOTHING
            `)
        }
    }

    logger.info({ workspaceId, source, created, existing }, 'graphMutate complete')
    return { nodeIds, created, existing }
}

interface ExpandRow {
    id: string
    label: string
    type: string | null
    depth: number
    [key: string]: unknown
}

/**
 * Embed the stimulus, pick the nearest concept node as seed, then walk
 * concept_edges via recursive CTE up to depth/width caps. Truncated when
 * the result count exceeds the width cap.
 */
export async function graphExpand(params: {
    workspaceId: string
    stimulus: string
    depth?: number
    width?: number
    aiSettings?: WorkspaceAISettings
}): Promise<ExpandResult> {
    const { workspaceId, stimulus, aiSettings } = params
    const depth = Math.min(Math.max(params.depth ?? DEFAULT_DEPTH, 0), MAX_DEPTH)
    const width = Math.min(Math.max(params.width ?? DEFAULT_WIDTH, 1), MAX_WIDTH)

    if (!stimulus.trim()) return { nodes: [], truncated: false }

    const vector = await embed(stimulus, workspaceId, aiSettings).catch((err: unknown) => {
        logger.warn({ err, workspaceId }, 'graphExpand: embed failed')
        return null
    })
    if (!vector) return { nodes: [], truncated: false }

    const vecStr = `[${vector.join(',')}]`

    // Set per-statement timeout to bound recursive CTE runtime.
    await db.execute(sql.raw(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`))

    const rows = await db.execute<ExpandRow>(sql`
        WITH RECURSIVE seed AS (
            SELECT id FROM concept_nodes
            WHERE workspace_id = ${workspaceId}::uuid
              AND embedding IS NOT NULL
            ORDER BY embedding <=> ${vecStr}::vector
            LIMIT 1
        ),
        bfs(id, d) AS (
            SELECT id, 0 FROM seed
            UNION
            SELECT e.dst_node_id, b.d + 1
            FROM bfs b
            JOIN concept_edges e
              ON e.src_node_id = b.id
             AND e.workspace_id = ${workspaceId}::uuid
            WHERE b.d < ${depth}
        )
        SELECT n.id, n.label, n.type, MIN(b.d)::int AS depth
        FROM bfs b
        JOIN concept_nodes n ON n.id = b.id
        GROUP BY n.id, n.label, n.type
        ORDER BY MIN(b.d) ASC, n.label ASC
        LIMIT ${width + 1}
    `)

    const truncated = rows.length > width
    const nodes = rows.slice(0, width).map((r) => ({
        id: r.id,
        label: r.label,
        type: r.type,
        depth: typeof r.depth === 'number' ? r.depth : Number(r.depth),
    }))

    return { nodes, truncated }
}

interface MetaRow {
    node_count: number
    edge_count: number
    last_update: Date | null
    [key: string]: unknown
}

export async function getGraphMeta(params: { workspaceId: string }): Promise<GraphMeta> {
    const { workspaceId } = params
    const rows = await db.execute<MetaRow>(sql`
        SELECT
            (SELECT COUNT(*) FROM concept_nodes WHERE workspace_id = ${workspaceId}::uuid)::int AS node_count,
            (SELECT COUNT(*) FROM concept_edges WHERE workspace_id = ${workspaceId}::uuid)::int AS edge_count,
            (SELECT MAX(updated_at) FROM concept_nodes WHERE workspace_id = ${workspaceId}::uuid) AS last_update
    `)
    const row = rows[0]
    return {
        nodeCount: row?.node_count ?? 0,
        edgeCount: row?.edge_count ?? 0,
        lastUpdate: row?.last_update ?? null,
    }
}

/**
 * Heartbeat for graph extraction. The real linker runs synchronously inside
 * the memory-extraction worker after each fact is persisted, so this entry
 * point mostly serves as an audit signal callers can hit explicitly.
 */
export async function triggerGraphExtract(params: {
    workspaceId: string
    sourceLogId?: string
}): Promise<{ ok: true }> {
    logger.info(
        { workspaceId: params.workspaceId, sourceLogId: params.sourceLogId },
        'graph extract trigger received',
    )
    return { ok: true }
}
