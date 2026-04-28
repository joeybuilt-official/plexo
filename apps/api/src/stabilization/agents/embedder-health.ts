// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Probes the local embeddings server. Asserts the model is loaded and
 * the returned vector dimension matches the system's expected shape (384
 * for snowflake-arctic-embed-s). Drift here breaks pgvector queries and
 * cluster coverage; catch it before users do.
 */

import type { Agent, Alert } from './index.js'

const EMBEDDING_URL = process.env.EMBEDDING_INTERNAL_URL ?? 'http://localhost:3001'
const EXPECTED_DIM = parseInt(process.env.EMBEDDING_DIM ?? '384', 10)

export const embedderHealth: Agent = {
    name: 'embedder-health',
    intervalSec: 5 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        let healthRes: Response
        try {
            healthRes = await fetch(`${EMBEDDING_URL}/health`, { signal: AbortSignal.timeout(5000) })
        } catch (err) {
            return {
                agent: 'embedder-health',
                at,
                severity: 'critical',
                message: `Embedder unreachable at ${EMBEDDING_URL}`,
                metadata: { error: err instanceof Error ? err.message : String(err) },
            }
        }
        if (!healthRes.ok) {
            return {
                agent: 'embedder-health',
                at,
                severity: 'critical',
                message: `Embedder /health returned ${healthRes.status}`,
                metadata: { status: healthRes.status },
            }
        }

        // Round-trip: embed a fixed string, assert the dimension.
        try {
            const embedRes = await fetch(`${EMBEDDING_URL}/v1/embeddings`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ input: 'plexo monitor probe', model: 'plexo-embed-v1' }),
                signal: AbortSignal.timeout(10_000),
            })
            if (!embedRes.ok) {
                return {
                    agent: 'embedder-health',
                    at,
                    severity: 'critical',
                    message: `Embedding request failed with ${embedRes.status}`,
                    metadata: { status: embedRes.status },
                }
            }
            const body = await embedRes.json() as { data?: { embedding?: number[] }[] }
            const dim = body.data?.[0]?.embedding?.length ?? 0
            if (dim !== EXPECTED_DIM) {
                return {
                    agent: 'embedder-health',
                    at,
                    severity: 'critical',
                    message: `Embedding dimension drift: got ${dim}, expected ${EXPECTED_DIM}`,
                    metadata: { dim, expected: EXPECTED_DIM },
                }
            }
        } catch (err) {
            return {
                agent: 'embedder-health',
                at,
                severity: 'error',
                message: `Embedding probe threw: ${err instanceof Error ? err.message : String(err)}`,
            }
        }

        return null
    },
}
