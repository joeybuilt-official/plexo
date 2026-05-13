// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cypher-backed execution wave + critical-path utilities — Phase B1
 * (ADR 0020). Reads Task / DEPENDS_ON nodes from FalkorDB via the
 * graphiti-sidecar /v1/graph/cypher endpoint and projects them to the
 * same wave shape returned by `utils/topo-sort.buildExecutionWaves`.
 *
 * Return-shape contract: `buildCypherExecutionWaves` returns numeric
 * waves (number[][]) to mirror `sprint/planner.ts`'s `executionOrder`
 * shape downstream. For the string-id shape used by topo-sort tests we
 * expose `buildCypherExecutionWavesById` which keeps task ids as
 * strings. Both are layered BFS — wave N = tasks whose deps all sit in
 * waves 0..N-1.
 *
 * Failure mode: every call returns `null` on bridge error / unconfigured
 * env / HMAC failure / malformed result. Callers MUST treat null as
 * "use the JS fallback" — this is a feature, not a defect.
 */

import { createHmac } from 'node:crypto'
import pino from 'pino'

const logger = pino({ name: 'cypher-waves' })

export interface CypherTask {
    id: string
    description: string
    status: string
    priority?: number
    scope?: string[]
    acceptance?: string
    branch?: string
    sprint_id?: string
}

export interface CypherWavesConfig {
    baseUrl?: string
    serviceKey?: string
    appId?: string
    fetchImpl?: typeof fetch
}

interface CypherResponse {
    header: string[]
    rows: unknown[][]
}

const APP_ID_DEFAULT = 'plexo-agent'

function resolveConfig(cfg?: CypherWavesConfig): { baseUrl: string; serviceKey: string; appId: string; fetchImpl: typeof fetch } | null {
    const baseUrl = cfg?.baseUrl ?? process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = cfg?.serviceKey ?? process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) return null
    return {
        baseUrl: baseUrl.replace(/\/$/, ''),
        serviceKey,
        appId: cfg?.appId ?? APP_ID_DEFAULT,
        fetchImpl: cfg?.fetchImpl ?? fetch,
    }
}

function sign(serviceKey: string, body: string): { sig: string; ts: string } {
    const sig = 'sha256=' + createHmac('sha256', serviceKey).update(body).digest('hex')
    const ts = new Date().toISOString()
    return { sig, ts }
}

async function postCypher(
    workspaceId: string,
    cypher: string,
    params: Record<string, unknown>,
    cfg?: CypherWavesConfig,
): Promise<CypherResponse | null> {
    const resolved = resolveConfig(cfg)
    if (!resolved) {
        logger.debug({ workspaceId }, 'cypher-waves: sidecar URL or service key not set')
        return null
    }
    const body = JSON.stringify({ workspace_id: workspaceId, cypher, params })
    const { sig, ts } = sign(resolved.serviceKey, body)
    try {
        const res = await resolved.fetchImpl(`${resolved.baseUrl}/v1/graph/cypher`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-App-Id': resolved.appId,
                'X-Plexo-Timestamp': ts,
                'X-Plexo-Signature': sig,
            },
            body,
        })
        if (!res.ok) {
            logger.warn({ workspaceId, status: res.status }, 'cypher-waves: sidecar returned non-OK')
            return null
        }
        return (await res.json()) as CypherResponse
    } catch (err) {
        logger.warn({ err, workspaceId }, 'cypher-waves: fetch failed')
        return null
    }
}

/**
 * Layered BFS via cypher. Returns the same shape as
 * `utils/topo-sort.buildExecutionWaves` projected to string ids.
 *
 * Algorithm:
 *   1. Fetch every Task in the sprint with its outbound DEPENDS_ON ids.
 *   2. Build dep map in-process.
 *   3. Emit waves: wave 0 = tasks w/ no deps inside the sprint; wave N
 *      = tasks whose deps all sit in waves 0..N-1.
 *
 * We do the layering client-side rather than via recursive cypher
 * because FalkorDB's GraphBLAS path is faster on a single MATCH +
 * COLLECT than on N round-trips, and the layering is O(V+E) which is
 * negligible for sprint-sized DAGs (≤8 tasks).
 */
export async function buildCypherExecutionWavesById(
    workspaceId: string,
    sprintId: string,
    cfg?: CypherWavesConfig,
): Promise<string[][] | null> {
    const cypher = `
        MATCH (t:Task {sprint_id: $sprint_id})
        OPTIONAL MATCH (t)-[:DEPENDS_ON]->(d:Task {sprint_id: $sprint_id})
        RETURN t.id AS id, collect(DISTINCT d.id) AS deps
    `.trim()
    const result = await postCypher(workspaceId, cypher, { sprint_id: sprintId }, cfg)
    if (!result) return null

    const idIdx = result.header.indexOf('id')
    const depsIdx = result.header.indexOf('deps')
    if (idIdx < 0 || depsIdx < 0) {
        logger.warn({ workspaceId, sprintId, header: result.header }, 'cypher-waves: unexpected header')
        return null
    }

    type Row = { id: string; deps: string[] }
    const rows: Row[] = []
    for (const r of result.rows) {
        const id = r[idIdx]
        const deps = r[depsIdx]
        if (typeof id !== 'string') continue
        const depList = Array.isArray(deps)
            ? deps.filter((d): d is string => typeof d === 'string' && d.length > 0)
            : []
        rows.push({ id, deps: depList })
    }

    return layerWaves(rows)
}

/**
 * Numeric wrapper for callers (sprint/planner.ts) that need number[][]
 * to mirror the JS `buildExecutionWaves(tasks)` shape downstream. Task
 * ids are local strings ("t1", "t2", ...) — we keep them as strings
 * since the sprint planner's `executionOrder: string[][]` is already
 * the string shape. This function exists for parity w/ the spec
 * signature `buildCypherExecutionWaves(workspaceId, sprintId): Promise<number[][]>`.
 *
 * For sprint planner the ids are non-numeric ("t1"). We expose the
 * string version directly; the spec signature is preserved as an alias
 * that just casts via String→Number when ids are pure numerics (used
 * by planner/index.ts's PlanStep.stepNumber path if/when migrated).
 */
export async function buildCypherExecutionWaves(
    workspaceId: string,
    sprintId: string,
    cfg?: CypherWavesConfig,
): Promise<number[][] | null> {
    const stringWaves = await buildCypherExecutionWavesById(workspaceId, sprintId, cfg)
    if (!stringWaves) return null
    return stringWaves.map((wave) =>
        wave.map((id) => {
            const n = Number(id)
            return Number.isFinite(n) ? n : NaN
        }),
    )
}

/**
 * Longest DEPENDS_ON* chain ending at a leaf Task (no outbound
 * DEPENDS_ON inside the sprint). Returns nodes ordered root→leaf.
 *
 * Implementation: variable-length cypher pattern, take the path with
 * max length. FalkorDB's `length(p)` is constant-time per row.
 */
export async function criticalPathToCompletion(
    workspaceId: string,
    sprintId: string,
    cfg?: CypherWavesConfig,
): Promise<CypherTask[] | null> {
    const cypher = `
        MATCH p = (root:Task {sprint_id: $sprint_id})-[:DEPENDS_ON*0..]->(leaf:Task {sprint_id: $sprint_id})
        WHERE NOT (root)<-[:DEPENDS_ON]-(:Task {sprint_id: $sprint_id})
          AND NOT (leaf)-[:DEPENDS_ON]->(:Task {sprint_id: $sprint_id})
        RETURN nodes(p) AS chain, length(p) AS hops
        ORDER BY hops DESC
        LIMIT 1
    `.trim()
    const result = await postCypher(workspaceId, cypher, { sprint_id: sprintId }, cfg)
    if (!result) return null

    const chainIdx = result.header.indexOf('chain')
    if (chainIdx < 0 || result.rows.length === 0) return []

    const chain = result.rows[0]?.[chainIdx]
    if (!Array.isArray(chain)) return []

    const tasks: CypherTask[] = []
    for (const node of chain) {
        // FalkorDB serializes Nodes as { labels, properties, id }
        if (node && typeof node === 'object' && 'properties' in node) {
            const props = (node as { properties: Record<string, unknown> }).properties
            if (typeof props.id === 'string' && typeof props.description === 'string' && typeof props.status === 'string') {
                tasks.push({
                    id: props.id,
                    description: props.description,
                    status: props.status,
                    priority: typeof props.priority === 'number' ? props.priority : undefined,
                    scope: Array.isArray(props.scope) ? props.scope.filter((s): s is string => typeof s === 'string') : undefined,
                    acceptance: typeof props.acceptance === 'string' ? props.acceptance : undefined,
                    branch: typeof props.branch === 'string' ? props.branch : undefined,
                    sprint_id: typeof props.sprint_id === 'string' ? props.sprint_id : undefined,
                })
            }
        }
    }
    return tasks
}

// ── Internal: client-side layering (shared w/ topo-sort.ts semantics) ────────

function layerWaves(rows: Array<{ id: string; deps: string[] }>): string[][] {
    const idSet = new Set(rows.map((r) => r.id))
    const resolved = new Set<string>()
    const waves: string[][] = []
    let remaining = [...rows]

    while (remaining.length > 0) {
        const wave = remaining.filter((r) =>
            r.deps.every((dep) => !idSet.has(dep) || resolved.has(dep)),
        )
        if (wave.length === 0) {
            // Cycle — mirror topo-sort.ts: dump remaining as final wave.
            logger.warn({ remaining: remaining.map((r) => r.id) }, 'cypher-waves: cycle detected — dumping remaining as single wave')
            waves.push(remaining.map((r) => r.id))
            break
        }
        waves.push(wave.map((r) => r.id))
        for (const r of wave) resolved.add(r.id)
        remaining = remaining.filter((r) => !resolved.has(r.id))
    }
    return waves
}
