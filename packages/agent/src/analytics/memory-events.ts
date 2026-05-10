// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory system observability — plexo_ops_analytics emitters.
 *
 * Eight events cover the memory pipeline end-to-end:
 *   memory.extraction        facts persisted from a conversation turn
 *   memory.embedded          embedding written to memory_entries
 *   memory.retrieval         queryMemory returned at least one row
 *   memory.cache-hit         search-result cache served the query
 *   memory.cache-miss        search-result cache fell through to DB
 *   memory.retrieval-flush   tier cooling pass completed (cron)
 *   memory.confidence-decay  weekly decay pass completed (cron)
 *   memory.user-write        explicit user instruction persisted
 *
 * All emitters are fire-and-forget: never throw, never block the hot path.
 */
import { db, sql } from '@plexo/db'

const INSTANCE = () => process.env.PLEXO_INSTANCE_ID ?? 'unknown'

async function emit(event: string, payload: Record<string, unknown>): Promise<void> {
    try {
        await db.execute(sql`
            INSERT INTO plexo_ops_analytics (app, event_name, properties, instance_uuid)
            VALUES ('plexo', ${event}, ${JSON.stringify(payload)}::jsonb, ${INSTANCE()})
        `)
    } catch {
        /* observability must never break the caller */
    }
}

export function emitMemoryExtraction(opts: {
    workspaceId: string
    factsExtracted: number
    factsWritten: number
    source: string
    sessionId: string
}): void {
    void emit('memory.extraction', {
        workspace_id: opts.workspaceId,
        facts_extracted: opts.factsExtracted,
        facts_written: opts.factsWritten,
        source: opts.source,
        session_id: opts.sessionId,
    })
}

export function emitMemoryEmbedded(opts: {
    workspaceId: string
    factId: string
    dimensions: number
    latencyMs: number
}): void {
    void emit('memory.embedded', {
        workspace_id: opts.workspaceId,
        fact_id: opts.factId,
        dimensions: opts.dimensions,
        latency_ms: opts.latencyMs,
    })
}

export function emitMemoryRetrieval(opts: {
    workspaceId: string
    userId?: string
    mode: 'vector' | 'keyword' | 'hybrid'
    resultCount: number
    latencyMs: number
}): void {
    void emit('memory.retrieval', {
        workspace_id: opts.workspaceId,
        user_id: opts.userId ?? null,
        mode: opts.mode,
        result_count: opts.resultCount,
        latency_ms: opts.latencyMs,
    })
}

export function emitMemoryCacheHit(opts: {
    workspaceId: string
    cacheKind: 'search' | 'prefs'
}): void {
    void emit('memory.cache-hit', {
        workspace_id: opts.workspaceId,
        cache_kind: opts.cacheKind,
    })
}

export function emitMemoryCacheMiss(opts: {
    workspaceId: string
    cacheKind: 'search' | 'prefs'
}): void {
    void emit('memory.cache-miss', {
        workspace_id: opts.workspaceId,
        cache_kind: opts.cacheKind,
    })
}

export function emitMemoryRetrievalFlush(opts: {
    cooledCount: number
    frozenCount: number
}): void {
    void emit('memory.retrieval-flush', {
        cooled_count: opts.cooledCount,
        frozen_count: opts.frozenCount,
    })
}

export function emitMemoryConfidenceDecay(opts: {
    decayedCount: number
    factor: number
    floor: number
}): void {
    void emit('memory.confidence-decay', {
        decayed_count: opts.decayedCount,
        factor: opts.factor,
        floor: opts.floor,
    })
}

/**
 * Phase 6 follow-up — plan-time memory injection.
 *
 * Emits when `buildMemoryBlock` injects facts into the planner system prompt.
 * Fires both on success (factsInjected > 0) and on the empty/error paths
 * (factsInjected = 0, retrievalFailed = true|false) so downstream analytics
 * can correlate "plans informed by memory" with plan quality / outcome.
 *
 * Distinct from `memory.retrieval`, which fires on every queryMemory call.
 * This event is planner-specific and tells you whether a plan actually got
 * past-context injected.
 */
export function emitMemoryInjection(opts: {
    workspaceId: string
    userId?: string
    factsInjected: number
    retrievalFailed: boolean
}): void {
    void emit('memory.plan-injection', {
        workspace_id: opts.workspaceId,
        user_id: opts.userId ?? null,
        facts_injected: opts.factsInjected,
        retrieval_failed: opts.retrievalFailed,
    })
}

export function emitMemoryUserWrite(opts: {
    workspaceId: string
    ruleKey: string
    ruleType: string
    conditional: boolean
}): void {
    void emit('memory.user-write', {
        workspace_id: opts.workspaceId,
        rule_key: opts.ruleKey,
        rule_type: opts.ruleType,
        conditional: opts.conditional,
    })
}

/**
 * Phase 5 — every memory write emits one of these so the dashboards can
 * compute `graphiti.write.success.rate` over an arbitrary window.
 */
export function emitMemoryWriteBackend(opts: {
    workspaceId: string
    mode: 'graphiti' | 'dual' | 'postgres'
    graphitiOk: boolean
    latencyMs: number
    episodeId?: string
    extractedFacts?: number
    reason?: string
}): void {
    void emit('memory.write-backend', {
        workspace_id: opts.workspaceId,
        mode: opts.mode,
        graphiti_ok: opts.graphitiOk,
        latency_ms: opts.latencyMs,
        episode_id: opts.episodeId ?? null,
        extracted_facts: opts.extractedFacts ?? null,
        reason: opts.reason ?? null,
    })
}

/**
 * Phase 5 — divergence-detector output. Emitted from a periodic sampler
 * (operator-triggered today; cron-wired post-Phase-9).
 */
export function emitMemoryDivergence(opts: {
    workspaceId: string
    sampled: number
    missingInGraphiti: number
}): void {
    void emit('memory.divergence', {
        workspace_id: opts.workspaceId,
        sampled: opts.sampled,
        missing_in_graphiti: opts.missingInGraphiti,
        missing_pct: opts.sampled === 0 ? 0 : opts.missingInGraphiti / opts.sampled,
    })
}
