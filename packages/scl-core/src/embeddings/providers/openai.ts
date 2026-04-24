// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { EmbeddingProvider } from '../../types.js'

const MODEL = 'text-embedding-3-small'
const DIMENSIONS = 1536
const ENDPOINT = 'https://api.openai.com/v1/embeddings'

/**
 * OpenAI text-embedding-3-small provider.
 * Matches the model already used by Plexo's memory/store.ts.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
    private apiKey: string

    constructor(apiKey: string) {
        if (!apiKey) throw new Error('OpenAI API key required for embedding provider')
        this.apiKey = apiKey
    }

    dimensions(): number {
        return DIMENSIONS
    }

    async embed(text: string): Promise<number[]> {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: MODEL,
                input: text,
            }),
            signal: AbortSignal.timeout(15_000),
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw new Error(`Embedding API error ${res.status}: ${body.slice(0, 200)}`)
        }

        const data = await res.json() as { data: Array<{ embedding: number[] }> }
        const vector = data.data[0]?.embedding
        if (!vector || vector.length !== DIMENSIONS) {
            throw new Error(`Unexpected embedding dimensions: got ${vector?.length ?? 0}, expected ${DIMENSIONS}`)
        }

        return vector
    }
}
