// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL concept-graph query layer (ADR 0008).
 *
 * Backs `/api/v1/scl/{mutate,expand,record/meta,extract/trigger}`. The graph
 * is stored as `scl_concept_graphs.graph_json`:
 *
 *   { concepts: [{ id, label, type, addedAt }] }
 *
 * Append-only — `mutate` deduplicates by (label,type) case-insensitive. A
 * `SELECT … FOR UPDATE` lock inside a transaction prevents lost-update races
 * between concurrent mutators.
 *
 * One row per workspace is materialised on first mutate (`domain_region` left
 * null). Read paths pick the most-recently-updated row for the workspace.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'

const logger = pino({ name: 'scl-query' })

const EXPAND_DEPTH_DEFAULT = 2
const EXPAND_DEPTH_MAX = 4
const EXPAND_WIDTH_DEFAULT = 50
const EXPAND_WIDTH_MAX = 200

export interface SclConcept {
    id: string
    label: string
    type: string
}

export interface ExpandOptions {
    depth?: number
    width?: number
}

export interface ExpandResult {
    nodes: SclConcept[]
    truncated: boolean
}

interface StoredConcept extends SclConcept {
    addedAt: string
}

interface GraphJson {
    concepts?: StoredConcept[]
}

interface GraphRow {
    id: string
    graph_json: GraphJson | null
    [k: string]: unknown
}

interface MindsetRow {
    mindset_object: Record<string, unknown> | null
    [k: string]: unknown
}

function normalizeKey(label: string, type: string): string {
    return `${label.trim().toLowerCase()}|${type.trim().toLowerCase()}`
}

/**
 * Append concepts to the workspace's SCL concept graph. Idempotent w.r.t.
 * (label,type) pairs. Source string is currently unused beyond the audit log
 * — kept on the signature so callers don't have to change when we wire it.
 */
export async function mutateConceptGraph(
    workspaceId: string,
    concepts: Array<{ label: string; type: string }>,
    source: string,
): Promise<{ added: number; total: number }> {
    if (concepts.length === 0) return { added: 0, total: 0 }

    return db.transaction(async (tx) => {
        const existingRows = Array.from(
            await tx.execute<GraphRow>(sql`
                SELECT id, graph_json
                FROM scl_concept_graphs
                WHERE workspace_id = ${workspaceId}::uuid
                  AND domain_region IS NULL
                ORDER BY updated_at DESC
                LIMIT 1
                FOR UPDATE
            `),
        )

        const now = new Date().toISOString()
        const seen = new Set<string>()
        const merged: StoredConcept[] = []

        const existingConcepts = existingRows[0]?.graph_json?.concepts ?? []
        for (const c of existingConcepts) {
            const key = normalizeKey(c.label, c.type)
            if (seen.has(key)) continue
            seen.add(key)
            merged.push(c)
        }

        let added = 0
        for (const c of concepts) {
            if (!c.label?.trim() || !c.type?.trim()) continue
            const key = normalizeKey(c.label, c.type)
            if (seen.has(key)) continue
            seen.add(key)
            merged.push({
                id: crypto.randomUUID(),
                label: c.label.trim(),
                type: c.type.trim(),
                addedAt: now,
            })
            added++
        }

        const graphJson: GraphJson = { concepts: merged }

        if (existingRows.length > 0) {
            await tx.execute(sql`
                UPDATE scl_concept_graphs
                SET graph_json = ${JSON.stringify(graphJson)}::jsonb,
                    updated_at = NOW()
                WHERE id = ${existingRows[0]!.id}::uuid
            `)
        } else {
            await tx.execute(sql`
                INSERT INTO scl_concept_graphs (workspace_id, graph_json)
                VALUES (${workspaceId}::uuid, ${JSON.stringify(graphJson)}::jsonb)
            `)
        }

        logger.debug({ workspaceId, source, added, total: merged.length }, 'mutateConceptGraph')
        return { added, total: merged.length }
    })
}

/**
 * Stimulus-driven concept lookup. MVP: case-insensitive substring match on
 * label, then dedup. `depth`/`width` are accepted for forward-compat with
 * edge-aware traversal but currently bound the result count only.
 */
export async function expandConceptGraph(
    workspaceId: string,
    stimulus: string,
    opts: ExpandOptions = {},
): Promise<ExpandResult> {
    const width = Math.min(Math.max(opts.width ?? EXPAND_WIDTH_DEFAULT, 1), EXPAND_WIDTH_MAX)
    // depth reserved for edge-aware traversal once edges are persisted
    const _depth = Math.min(Math.max(opts.depth ?? EXPAND_DEPTH_DEFAULT, 1), EXPAND_DEPTH_MAX)
    void _depth

    const stim = stimulus.trim().toLowerCase()
    if (!stim) return { nodes: [], truncated: false }

    const rows = Array.from(
        await db.execute<GraphRow>(sql`
            SELECT id, graph_json
            FROM scl_concept_graphs
            WHERE workspace_id = ${workspaceId}::uuid
            ORDER BY updated_at DESC
            LIMIT 1
        `),
    )
    const concepts = rows[0]?.graph_json?.concepts ?? []

    const tokens = stim.split(/\s+/).filter(t => t.length >= 2)
    const matches: SclConcept[] = []
    for (const c of concepts) {
        const hay = c.label.toLowerCase()
        const hit = tokens.length === 0
            ? hay.includes(stim)
            : tokens.some(t => hay.includes(t))
        if (hit) matches.push({ id: c.id, label: c.label, type: c.type })
        if (matches.length >= width + 1) break
    }
    const truncated = matches.length > width
    return { nodes: matches.slice(0, width), truncated }
}

/**
 * Read the workspace's golden-record metadata (`mindset_object`). Returns
 * the stored object as-is, plus a derived `enabled` flag matching the
 * shape expected by `nexalog.GoldenRecordMeta`.
 */
export async function getGoldenRecordMeta(workspaceId: string): Promise<Record<string, unknown> | null> {
    const rows = Array.from(
        await db.execute<MindsetRow>(sql`
            SELECT mindset_object
            FROM scl_concept_graphs
            WHERE workspace_id = ${workspaceId}::uuid
              AND mindset_object IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1
        `),
    )
    const obj = rows[0]?.mindset_object
    if (!obj || typeof obj !== 'object') return null
    return { enabled: true, ...obj }
}

/**
 * Trigger an SCL extraction pass. MVP: log + return ok. Real extraction is
 * already cron-driven via `evaluateSclPromotion`. Future: enqueue a worker
 * job. Fire-and-forget from the caller's side, so a 200 here is sufficient.
 */
export async function triggerSclExtract(
    workspaceId: string,
    source: string,
    sourceLogId?: string,
): Promise<{ ok: true }> {
    logger.info({ workspaceId, source, sourceLogId }, 'triggerSclExtract')
    return { ok: true }
}
