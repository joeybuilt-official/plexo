// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory write-backend gateway. Phase 5 of `graphiti-migration/plan.md`.
 *
 * Three modes selected via the `MEMORY_WRITE_BACKEND` env var:
 *
 *   postgres  — today's path; inserts into memory_entries only.
 *               DEFAULT, by design: keeps prod behavior unchanged until the
 *               operator explicitly cuts over. The plan calls for `dual` to
 *               become the default after the Phase 3c sidecar smoke is
 *               green and Phase 4 policy thresholds are confirmed; flipping
 *               this default is a one-line config change, not a re-deploy.
 *   dual      — both stores receive the write; rollback is a flag flip
 *               with no data loss. Mirror failures are logged + counted
 *               but do not fail the postgres write.
 *   graphiti  — Graphiti-only; postgres insert is skipped entirely.
 *               Phase 9 cutover flips the default here; Phase 5 ships
 *               the path so dual-mode + graphiti-mode are interchangeable
 *               at flag-flip time.
 *
 * Bridge construction is lazy — the module never makes a network call at
 * import time, and missing PLEXO_GRAPHITI_SIDECAR_URL / PLEXO_SERVICE_KEY
 * just degrades to "postgres-only" with a one-time warning. That gives the
 * dev environment a safe default if the sidecar isn't running.
 */

import { randomUUID } from 'node:crypto'
import pino from 'pino'
import { GraphitiClient, type AddEpisodeRequest } from '@plexo/graphiti-bridge'
import { emitMemoryWriteBackend } from '../analytics/memory-events.js'

const logger = pino({ name: 'memory-write-backend' })

export type WriteBackend = 'postgres' | 'dual' | 'graphiti'

let _client: GraphitiClient | null = null
let _clientWarned = false

const VALID_BACKENDS = new Set<string>(['postgres', 'dual', 'graphiti'])

export function getWriteBackend(): WriteBackend {
    const raw = (process.env.MEMORY_WRITE_BACKEND ?? 'postgres').toLowerCase()
    if (!VALID_BACKENDS.has(raw)) {
        logger.warn({ raw }, 'MEMORY_WRITE_BACKEND unrecognised; falling back to postgres')
        return 'postgres'
    }
    return raw as WriteBackend
}

export function shouldWritePostgres(backend: WriteBackend = getWriteBackend()): boolean {
    return backend === 'postgres' || backend === 'dual'
}

export function shouldMirrorGraphiti(backend: WriteBackend = getWriteBackend()): boolean {
    return backend === 'graphiti' || backend === 'dual'
}

function getClient(): GraphitiClient | null {
    if (_client) return _client
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) {
        if (!_clientWarned) {
            logger.warn(
                { hasBaseUrl: !!baseUrl, hasServiceKey: !!serviceKey },
                'graphiti bridge not configured; memory writes will skip the mirror path even when MEMORY_WRITE_BACKEND requests it',
            )
            _clientWarned = true
        }
        return null
    }
    _client = new GraphitiClient({ baseUrl, serviceKey, appId: process.env.PLEXO_APP_ID ?? 'plexo-api' })
    return _client
}

/** Test hook — drops the cached client + warning latch. */
export function resetWriteBackendForTest(): void {
    _client = null
    _clientWarned = false
}

/** Test hook — inject a custom client (e.g. a mock). */
export function setWriteBackendClientForTest(client: GraphitiClient | null): void {
    _client = client
    _clientWarned = client !== null
}

export interface MirrorMemoryArgs {
    workspaceId: string
    /** Free-form text content; used as Graphiti's episode_body. */
    content: string
    /** Provenance string — typically `${app}:${source}` (e.g. "plexo:chat"). */
    sourceDescription?: string
    /** Episode display name; defaults to derived from sourceDescription. */
    name?: string
    /** ISO-8601 reference time for bi-temporal placement. */
    referenceTime?: string
    /** Pre-structured fact triple; if all three present, the bridge can use add_fact_triple later. */
    triple?: { subject: string; predicate: string; object: string }
    /** Free-form metadata; merged into Graphiti's source_metadata. */
    metadata?: Record<string, unknown>
    /**
     * A3 S1 (ADR 0031, Path a) — plexo-side memory identity. Allocated
     * here if caller doesn't supply one; sidecar lifts onto the Episodic
     * node as a top-level prop. Becomes REQUIRED at A3 S4 cutover.
     */
    plexoMemoryId?: string
}

export interface MirrorResult {
    ok: boolean
    episodeId: string | null
    extractedFactsCount: number
    extractedNodesCount: number
    /** Wall-clock latency of the bridge round-trip; useful for the success-rate dashboards. */
    latencyMs: number
}

/** Single-write mirror to Graphiti. Never throws; null-on-failure. Emits analytics on every call. */
export async function mirrorToGraphiti(args: MirrorMemoryArgs): Promise<MirrorResult> {
    const start = Date.now()
    const client = getClient()
    if (!client) {
        const result: MirrorResult = { ok: false, episodeId: null, extractedFactsCount: 0, extractedNodesCount: 0, latencyMs: 0 }
        emitMemoryWriteBackend({ workspaceId: args.workspaceId, mode: getWriteBackend(), graphitiOk: false, latencyMs: 0, reason: 'bridge-not-configured' })
        return result
    }

    const plexoMemoryId = args.plexoMemoryId ?? (args.metadata?.plexo_memory_id as string | undefined) ?? randomUUID()
    const req: AddEpisodeRequest = {
        workspaceId: args.workspaceId,
        content: args.content,
        sourceDescription: args.sourceDescription,
        name: args.name,
        referenceTime: args.referenceTime,
        episodeType: 'message',
        sourceMetadata: {
            ...(args.metadata ?? {}),
            ...(args.triple ? { triple: args.triple } : {}),
            plexo_memory_id: plexoMemoryId,
        },
    }

    const res = await client.addEpisode(req)
    const latencyMs = Date.now() - start
    if (!res) {
        emitMemoryWriteBackend({ workspaceId: args.workspaceId, mode: getWriteBackend(), graphitiOk: false, latencyMs, reason: 'bridge-error' })
        return { ok: false, episodeId: null, extractedFactsCount: 0, extractedNodesCount: 0, latencyMs }
    }
    emitMemoryWriteBackend({
        workspaceId: args.workspaceId,
        mode: getWriteBackend(),
        graphitiOk: true,
        latencyMs,
        episodeId: res.episodeId ?? undefined,
        extractedFacts: res.extractedFactsCount,
    })
    return { ok: true, episodeId: res.episodeId, extractedFactsCount: res.extractedFactsCount, extractedNodesCount: res.extractedNodesCount, latencyMs }
}

export interface InvalidateLessonResult {
    ok: boolean
    deleted: number
    skipped?: boolean
}

/**
 * Physically delete all RELATES_TO edges belonging to a lesson episode.
 * Called by the lessons.graphiti.invalidate Inngest job when a revision is
 * rejected. Physical deletion is used because the graphiti sidecar's
 * /v1/search does not filter by invalid_at by default (Phase 0 finding).
 *
 * Idempotent — safe to call multiple times; a missing episode returns
 * {ok: true, deleted: 0, skipped: true}.
 */
export async function invalidateGraphitiLesson(workspaceId: string, revisionId: string): Promise<InvalidateLessonResult> {
    const client = getClient()
    if (!client) {
        logger.warn({ workspaceId, revisionId }, 'graphiti bridge not configured; lesson invalidation skipped')
        return { ok: true, deleted: 0, skipped: true }
    }

    const lessonName = `lesson:${revisionId}`

    const episodeRes = await client.cypher({
        workspaceId,
        cypher: 'MATCH (ep:Episodic) WHERE ep.name = $name RETURN ep.uuid LIMIT 1',
        params: { name: lessonName },
    })
    const epUuid = episodeRes?.rows?.[0]?.[0] as string | undefined
    if (!epUuid) {
        logger.info({ workspaceId, revisionId, lessonName }, 'lesson invalidate: episode not found (write may have been skipped or gate was off)')
        return { ok: true, deleted: 0, skipped: true }
    }

    // Count first so we can log a meaningful number — DELETE cannot return count(r)
    const countRes = await client.cypher({
        workspaceId,
        cypher: 'MATCH (a)-[r:RELATES_TO]->(b) WHERE $ep_id IN r.episodes RETURN count(r) AS n',
        params: { ep_id: epUuid },
    })
    const deleted = (countRes?.rows?.[0]?.[0] as number) ?? 0

    if (deleted > 0) {
        await client.cypher({
            workspaceId,
            cypher: 'MATCH (a)-[r:RELATES_TO]->(b) WHERE $ep_id IN r.episodes DELETE r',
            params: { ep_id: epUuid },
        })
    }

    logger.info({ workspaceId, revisionId, epUuid, deleted }, 'lesson invalidate: edges deleted')
    return { ok: true, deleted }
}
