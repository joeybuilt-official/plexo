// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory read-backend gateway. Phase 6 of `graphiti-migration/plan.md`.
 *
 * Counterpart to `write-backend.ts`. Selects between two read sources:
 *
 *   postgres  — DEFAULT. queryMemory + searchMemory keep their existing
 *               vector / keyword / hybrid SQL paths against
 *               `memory_entries`. Behavior unchanged from pre-Phase-6.
 *   graphiti  — both wrappers delegate to `bridge.search()` and map the
 *               returned edges back into the `MemorySearchResult` shape
 *               so downstream callers (planner, channel-ai, chat route,
 *               agent executor) don't change.
 *
 * The flip from postgres to graphiti is the operator gate AFTER Phase 5
 * dual-write has been observed clean for ≥7 days. Phase 6 ships the
 * routing so the flip is a flag flip, not a re-deploy.
 *
 * Audit pre-mortem #3 — same-session-recall fallback — is NOT wired in
 * Phase 6. Wire it (behind a separate feature flag) only if measured
 * read-quality regresses post-cutover; today's checklist defers it.
 */

import pino from 'pino'
import { GraphitiClient, type SearchResultEdge } from '@plexo/graphiti-bridge'
import type { MemorySearchResult, MemoryType, MemoryTier } from './store.js'
import { DEFAULT_NAMESPACE } from './namespace.js'

const logger = pino({ name: 'memory-read-backend' })

export type ReadBackend = 'graphiti' | 'postgres'

const VALID_BACKENDS: ReadonlySet<ReadBackend> = new Set(['graphiti', 'postgres'])

let _client: GraphitiClient | null = null
let _clientWarned = false

export function getReadBackend(): ReadBackend {
    const raw = (process.env.MEMORY_READ_BACKEND ?? 'postgres').toLowerCase() as ReadBackend
    if (!VALID_BACKENDS.has(raw)) {
        logger.warn({ raw }, 'invalid MEMORY_READ_BACKEND; defaulting to postgres')
        return 'postgres'
    }
    return raw
}

function getClient(): GraphitiClient | null {
    if (_client) return _client
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) {
        if (!_clientWarned) {
            logger.warn(
                { hasBaseUrl: !!baseUrl, hasServiceKey: !!serviceKey },
                'graphiti bridge not configured for reads; reads will fall back to postgres regardless of MEMORY_READ_BACKEND',
            )
            _clientWarned = true
        }
        return null
    }
    _client = new GraphitiClient({ baseUrl, serviceKey, appId: process.env.PLEXO_APP_ID ?? 'plexo-api' })
    return _client
}

export function resetReadBackendForTest(): void {
    _client = null
    _clientWarned = false
}

export function setReadBackendClientForTest(client: GraphitiClient | null): void {
    _client = client
    _clientWarned = client !== null
}

export interface GraphitiSearchOpts {
    workspaceId: string
    queryText: string
    limit: number
}

/**
 * Run a Graphiti hybrid search and map the returned edges into the
 * `MemorySearchResult` shape callers expect. Returns null if the bridge
 * isn't configured (caller should fall back to postgres) OR an empty
 * array if the search succeeded but returned nothing.
 */
export async function readFromGraphiti(opts: GraphitiSearchOpts): Promise<MemorySearchResult[] | null> {
    const client = getClient()
    if (!client) return null
    const res = await client.search({ workspaceId: opts.workspaceId, query: opts.queryText, numResults: opts.limit })
    if (!res) {
        logger.warn({ workspaceId: opts.workspaceId }, 'memory.read.graphiti: bridge.search returned null')
        return null
    }
    const total = res.results.length
    return res.results.map((edge, idx) => mapEdgeToResult(edge, opts.workspaceId, idx, total))
}

function mapEdgeToResult(edge: SearchResultEdge, workspaceId: string, rank: number, total: number): MemorySearchResult {
    // Graphiti's hybrid (semantic + BM25 + BFS) is RRF-fused and re-ranked by
    // OpenAIRerankerClient. The sidecar doesn't currently expose the per-edge
    // score, but the list order *is* the rank. Convert rank → similarity so
    // downstream UIs + threshold callers see a real gradient (top=1.0, tail→0).
    // Swap to the real graphiti score in Phase 5 once the sidecar redeploys.
    const similarity = total > 1 ? 1 - (rank / total) : 1
    return {
        id: edge.uuid ?? `graphiti:${workspaceId}:unknown`,
        workspaceId,
        type: 'pattern' as MemoryType,
        content: edge.fact ?? '',
        metadata: {
            graphiti_uuid: edge.uuid,
            source_node_uuid: edge.source_node_uuid,
            target_node_uuid: edge.target_node_uuid,
            valid_at: edge.valid_at,
            invalid_at: edge.invalid_at,
            graphiti_rank: rank,
        },
        tier: 'active' as MemoryTier,
        namespace: DEFAULT_NAMESPACE,
        createdAt: edge.created_at ? new Date(edge.created_at) : new Date(),
        similarity,
    }
}
