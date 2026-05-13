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

import pino from 'pino'
import { GraphitiClient, type AddEpisodeRequest } from '@plexo/graphiti-bridge'
import { emitMemoryWriteBackend } from '../analytics/memory-events.js'

const logger = pino({ name: 'memory-write-backend' })

export type WriteBackend = 'graphiti' | 'dual' | 'postgres'

const VALID_BACKENDS: ReadonlySet<WriteBackend> = new Set(['graphiti', 'dual', 'postgres'])

let _client: GraphitiClient | null = null
let _clientWarned = false

export function getWriteBackend(): WriteBackend {
    const raw = (process.env.MEMORY_WRITE_BACKEND ?? 'postgres').toLowerCase() as WriteBackend
    if (!VALID_BACKENDS.has(raw)) {
        logger.warn({ raw }, 'invalid MEMORY_WRITE_BACKEND; defaulting to postgres')
        return 'postgres'
    }
    return raw
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

    const req: AddEpisodeRequest = {
        workspaceId: args.workspaceId,
        content: args.content,
        sourceDescription: args.sourceDescription,
        name: args.name,
        referenceTime: args.referenceTime,
        episodeType: 'message',
        sourceMetadata: { ...(args.metadata ?? {}), ...(args.triple ? { triple: args.triple } : {}) },
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
