// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Embedding engine — loads ONNX model, runs inference.
 *
 * Uses onnxruntime-node to load snowflake-arctic-embed and produce
 * normalized embeddings. Thread-safe via ONNX Runtime's internal
 * session pooling (configurable via intra/inter op threads).
 */

import { InferenceSession, Tensor } from 'onnxruntime-node'
import { readFile } from 'fs/promises'
import { join } from 'path'
import pino from 'pino'
import { loadTokenizer, encode, type TokenizedInput } from './tokenizer.js'

const logger = pino({ name: 'embedding-engine' })

export interface EngineConfig {
    modelDir: string
    modelName: string
    interOpThreads?: number
    intraOpThreads?: number
}

export interface EmbeddingResult {
    embedding: number[]
    tokenCount: number
    latencyMs: number
}

interface ModelConfig {
    hidden_size?: number
    max_position_embeddings?: number
}

let session: InferenceSession | null = null
let dimensions = 384 // snowflake-arctic-embed-s default
let modelName = 'plexo-embed-v1'
let ready = false
let loadTimeMs = 0

/**
 * Initialize the embedding engine — load tokenizer + ONNX model.
 */
export async function initEngine(config: EngineConfig): Promise<void> {
    const start = performance.now()

    const modelPath = join(config.modelDir, 'model.onnx')
    const tokenizerPath = join(config.modelDir, 'tokenizer.json')
    const configPath = join(config.modelDir, 'config.json')

    // Load model config to get dimensions
    try {
        const raw = await readFile(configPath, 'utf-8')
        const modelConfig = JSON.parse(raw) as ModelConfig
        if (modelConfig.hidden_size) {
            dimensions = modelConfig.hidden_size
        }
    } catch (err) {
        logger.warn({ err }, 'Could not read config.json, using default dimensions')
    }

    // Load tokenizer
    await loadTokenizer(tokenizerPath)

    // Load ONNX model
    logger.info({ modelPath }, 'Loading ONNX model...')
    session = await InferenceSession.create(modelPath, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
        interOpNumThreads: config.interOpThreads ?? 2,
        intraOpNumThreads: config.intraOpThreads ?? 4,
    })

    modelName = config.modelName
    loadTimeMs = performance.now() - start
    ready = true

    logger.info({
        modelName,
        dimensions,
        loadTimeMs: loadTimeMs.toFixed(0),
        inputNames: session.inputNames,
        outputNames: session.outputNames,
    }, 'Embedding engine ready')
}

/**
 * Generate embedding for a single text input.
 */
export async function embed(text: string): Promise<EmbeddingResult> {
    if (!session || !ready) throw new Error('Engine not initialized')

    const start = performance.now()
    const tokenized = encode(text)

    const inputIds = new Tensor('int64', tokenized.inputIds, [1, tokenized.inputIds.length])
    const attentionMask = new Tensor('int64', tokenized.attentionMask, [1, tokenized.attentionMask.length])
    const tokenTypeIds = new Tensor('int64', tokenized.tokenTypeIds, [1, tokenized.tokenTypeIds.length])

    const feeds: Record<string, Tensor> = {
        input_ids: inputIds,
        attention_mask: attentionMask,
        token_type_ids: tokenTypeIds,
    }

    const results = await session.run(feeds)

    // The model outputs either 'last_hidden_state' or 'sentence_embedding'
    // snowflake-arctic-embed outputs 'last_hidden_state' — we need to pool it
    const outputName = session.outputNames[0]!
    const output = results[outputName]!
    const rawData = output.data as Float32Array

    let embedding: number[]

    // Check output shape — if it's [1, seq_len, hidden_size], we need CLS pooling
    // If it's [1, hidden_size], it's already pooled
    if (output.dims.length === 3) {
        // CLS token pooling — take first token's embedding
        embedding = Array.from(rawData.slice(0, dimensions))
    } else {
        embedding = Array.from(rawData.slice(0, dimensions))
    }

    // L2 normalize
    let norm = 0
    for (const v of embedding) norm += v * v
    norm = Math.sqrt(norm)
    if (norm > 0) {
        for (let i = 0; i < embedding.length; i++) {
            embedding[i] = embedding[i]! / norm
        }
    }

    const latencyMs = performance.now() - start

    return { embedding, tokenCount: tokenized.tokenCount, latencyMs }
}

/**
 * Generate embeddings for a batch of texts.
 */
export async function embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    // For now, sequential processing. ONNX Runtime handles internal parallelism.
    // Batch ONNX inference with dynamic shapes is complex; sequential with
    // intra-op parallelism is actually efficient for small batches.
    const results: EmbeddingResult[] = []
    for (const text of texts) {
        results.push(await embed(text))
    }
    return results
}

/**
 * Reload engine with a new model directory. Hot-swap without restart.
 */
export async function reloadEngine(config: EngineConfig): Promise<void> {
    const oldSession = session
    ready = false
    session = null

    try {
        await initEngine(config)
    } catch (err) {
        // Restore old session on failure
        session = oldSession
        ready = oldSession !== null
        throw err
    }

    // Dispose old session
    if (oldSession) {
        try {
            // onnxruntime-node sessions don't have an explicit dispose in all versions
            // but releasing the reference allows GC
        } catch { /* ignore */ }
    }
}

export function isReady(): boolean {
    return ready
}

export function getDimensions(): number {
    return dimensions
}

export function getModelName(): string {
    return modelName
}

export function getLoadTimeMs(): number {
    return loadTimeMs
}
