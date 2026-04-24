// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SCL context expansion for conversations.
 *
 * Uses real embeddings (via the workspace's configured provider) for
 * accurate semantic matching against the Golden Record. A 2-second
 * timeout guards the conversation hot path — on timeout or error,
 * falls back to the deterministic hash vector.
 *
 * Recent embeddings are LRU-cached to avoid redundant API calls for
 * repeated or similar messages within the same process lifetime.
 */

import pino from 'pino'
import { expand } from '@plexo/scl-core'
import { loadGoldenRecord, isSclEnabled } from './storage.js'
import { resolveEmbeddingProvider } from './embedding-provider.js'

const logger = pino({ name: 'scl:expand-context' })

/** Timeout (ms) for embedding API call in the conversation hot path. */
const EMBED_TIMEOUT_MS = 2000

/** L0 budget — enough for 3-5 attractors in conversation context. */
const CONVERSATION_CONTEXT_BUDGET = 50

// ---------------------------------------------------------------------------
// Simple LRU cache for message embeddings
// ---------------------------------------------------------------------------
const CACHE_MAX = 64

interface CacheEntry {
    key: string
    vector: number[]
}

const cache: CacheEntry[] = []

function cacheGet(key: string): number[] | undefined {
    const idx = cache.findIndex(e => e.key === key)
    if (idx === -1) return undefined
    // Move to front (most-recently used)
    const [entry] = cache.splice(idx, 1)
    cache.unshift(entry!)
    return entry!.vector
}

function cacheSet(key: string, vector: number[]): void {
    // Evict if at capacity
    if (cache.length >= CACHE_MAX) cache.pop()
    cache.unshift({ key, vector })
}

// ---------------------------------------------------------------------------
// Hash fallback (deterministic, no API call)
// ---------------------------------------------------------------------------

/**
 * Hash text into a deterministic vector for region matching.
 * NOT a real embedding — used only as fallback when the real provider
 * is unavailable or times out.
 */
function simpleTextVector(text: string, dims: number): number[] {
    const v = new Array<number>(dims).fill(0)
    const lower = text.toLowerCase()
    for (let i = 0; i < lower.length; i++) {
        const idx = (lower.charCodeAt(i) * (i + 1) * 31) % dims
        v[idx]! += 1
    }
    let mag = 0
    for (const x of v) mag += x * x
    mag = Math.sqrt(mag)
    if (mag > 0) for (let i = 0; i < dims; i++) v[i] = v[i]! / mag
    return v
}

// ---------------------------------------------------------------------------
// Embedding with timeout
// ---------------------------------------------------------------------------

async function embedWithTimeout(
    workspaceId: string,
    text: string,
    dims: number,
): Promise<{ vector: number[]; source: 'real' | 'cache' | 'hash' }> {
    // Check cache first
    const cacheKey = `${workspaceId}:${text.slice(0, 512)}`
    const cached = cacheGet(cacheKey)
    if (cached) return { vector: cached, source: 'cache' }

    try {
        const provider = await resolveEmbeddingProvider(workspaceId)

        // If the provider resolved to hash-fallback, skip the timeout dance
        if (provider.resolution.status === 'fallback-hash') {
            const v = simpleTextVector(text, dims)
            return { vector: v, source: 'hash' }
        }

        // Race the real embedding against a timeout
        const embedPromise = provider.embed(text.slice(0, 2000))
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('embedding timeout')), EMBED_TIMEOUT_MS),
        )

        const vector = await Promise.race([embedPromise, timeoutPromise])
        cacheSet(cacheKey, vector)
        return { vector, source: 'real' }
    } catch (err) {
        logger.warn(
            { err, workspaceId },
            'expandForConversation: real embedding failed/timed out, falling back to hash',
        )
        const v = simpleTextVector(text, dims)
        return { vector: v, source: 'hash' }
    }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Expand SCL context for a conversation message.
 * Returns a formatted context block, or null if SCL is off or empty.
 */
export async function expandForConversation(
    workspaceId: string,
    userMessage: string,
): Promise<string | null> {
    if (!(await isSclEnabled(workspaceId))) {
        logger.info({ workspaceId }, 'expandForConversation: SCL not enabled')
        return null
    }

    const record = await loadGoldenRecord(workspaceId)
    if (!record || record.attractors.length === 0) {
        logger.info(
            { workspaceId, hasRecord: !!record, attractors: record?.attractors?.length ?? 0 },
            'expandForConversation: no Golden Record or empty attractors',
        )
        return null
    }

    const dims = record.attractors[0]!.position.length
    const { vector: stimulus, source } = await embedWithTimeout(workspaceId, userMessage, dims)

    const expansion = expand(record, {
        stimulus,
        level: 'L0',
        contextBudget: CONVERSATION_CONTEXT_BUDGET,
        priority: 'relevance',
    })

    if (expansion.nodes.length === 0) {
        logger.info(
            { workspaceId, attractorCount: record.attractors.length, embeddingSource: source },
            'expandForConversation: expand returned 0 nodes',
        )
        return null
    }

    // Format: spirit anchors first, then mechanics by relevance
    const ordered = [...expansion.nodes].sort((a, b) => {
        if (a.depthClass === b.depthClass) return b.relevance - a.relevance
        return a.depthClass === 'spirit' ? -1 : 1
    })

    const lines: string[] = []
    lines.push(`=== YOUR LEARNED KNOWLEDGE (SCL Golden Record, ${ordered.length} concepts) ===`)
    for (const n of ordered) {
        const marker = n.depthClass === 'spirit' ? ' [CORE]' : ''
        const relevanceLabel =
            n.depthClass === 'spirit'
                ? 'always active'
                : `relevance: ${(n.relevance * 100).toFixed(0)}%`
        lines.push(`\u2022 ${n.label}${marker} (${relevanceLabel})`)
    }
    lines.push('=== END LEARNED KNOWLEDGE ===')

    const block = lines.join('\n')
    logger.info(
        {
            workspaceId,
            nodesExpanded: ordered.length,
            tokensEstimate: Math.ceil(block.length / 4),
            embeddingSource: source,
        },
        'expandForConversation: context injected',
    )
    return block
}
