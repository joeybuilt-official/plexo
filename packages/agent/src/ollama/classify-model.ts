// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Model capability classifier for Ollama.
 *
 * Takes a model name from Ollama's /api/tags and classifies it as
 * chat, embedding, or both. Used by admin endpoints and the
 * Intelligence page to show what each model can do.
 */

export type ModelCapability = 'chat' | 'embedding' | 'both'

/** Known embedding model name patterns. */
const EMBEDDING_PATTERNS = [
    /^nomic-embed/,
    /^mxbai-embed/,
    /^snowflake-arctic-embed/,
    /^bge-/,
    /^all-minilm/,
    /^gte-/,
    /^e5-/,
    /^jina-embeddings/,
    /^stella-/,
    /embed/i,
]

/** Known chat model family prefixes. */
const CHAT_PREFIXES = [
    'llama', 'mistral', 'qwen', 'phi', 'gemma', 'deepseek',
    'codellama', 'command-r', 'gpt-oss', 'wizardlm', 'vicuna',
    'orca', 'neural-chat', 'stablelm', 'tinyllama', 'dolphin',
    'openchat', 'solar', 'yarn', 'nous-hermes', 'mixtral',
    'starling', 'yi', 'falcon', 'internlm', 'mistral-nemo',
]

/**
 * Classify an Ollama model by its name.
 * Conservative: unknown models are classified as chat-only.
 */
export function classifyModel(name: string): ModelCapability {
    const lower = name.toLowerCase().split(':')[0]! // strip tag (e.g., ":latest")

    const isEmbedding = EMBEDDING_PATTERNS.some(p => p.test(lower))
    const isChat = CHAT_PREFIXES.some(p => lower.startsWith(p))

    if (isEmbedding && isChat) return 'both'
    if (isEmbedding) return 'embedding'
    // Conservative: if we don't recognize it as embedding, assume chat
    return 'chat'
}

/**
 * Get the default embedding dimensions for known embedding models.
 * Returns null for unknown models.
 */
export function getEmbeddingDimensions(name: string): number | null {
    const lower = name.toLowerCase().split(':')[0]!
    if (lower.startsWith('snowflake-arctic-embed')) return 1024
    if (lower.startsWith('mxbai-embed-large')) return 1024
    if (lower.startsWith('nomic-embed-text')) return 768
    if (lower.startsWith('bge-large')) return 1024
    if (lower.startsWith('bge-base')) return 768
    if (lower.startsWith('bge-small')) return 384
    if (lower.startsWith('all-minilm')) return 384
    if (lower.startsWith('gte-large')) return 1024
    if (lower.startsWith('gte-base')) return 768
    if (lower.startsWith('e5-large')) return 1024
    if (lower.startsWith('e5-base')) return 768
    return null
}
