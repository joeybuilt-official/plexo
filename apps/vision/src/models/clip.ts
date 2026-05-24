// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * CLIP (image ↔ text shared embedding) loader.
 *
 * Default model: OpenCLIP ViT-B/32 (LAION-2B). 512-dim output, the same
 * space Fonto and Immich use today so existing embeddings remain
 * comparable across services.
 *
 * Optional model: SigLIP-2 multilingual — opt-in via `modelId: "siglip-2"`
 * on the request. Same 512-dim output dimension (the SigLIP-2 base config),
 * different pretraining + tokenizer.
 *
 * BOOTSTRAP STATUS (Phase 4.1): the artifacts list below is empty — Phase
 * 4.2 will populate it with real SHA-256s and validated upstream URLs.
 * Until then, the loaders fast-fail with "model not configured" so the
 * server boots cleanly without giant .onnx files on disk.
 */

import { childLogger } from '../lib/logger.js'
import type { VisionTask } from '../lib/telemetry.js'

const logger = childLogger('clip')

export type ClipModelId = 'openclip-vit-b-32' | 'siglip-2'

export const CLIP_DIM = 512
export const DEFAULT_CLIP_MODEL: ClipModelId = 'openclip-vit-b-32'

interface ClipEngine {
    modelId: ClipModelId
    embedImage(input: string): Promise<number[]>
    embedText(input: string): Promise<number[]>
}

const engines = new Map<ClipModelId, ClipEngine>()

function notConfigured(modelId: ClipModelId, task: VisionTask): never {
    throw new Error(
        `CLIP model "${modelId}" not configured — Phase 4.1 ships the route ` +
            `surface only. Populate models/clip artifacts and SHA-256s in Phase 4.2 ` +
            `to enable ${task}.`,
    )
}

async function loadEngine(modelId: ClipModelId): Promise<ClipEngine> {
    if (engines.has(modelId)) return engines.get(modelId)!
    logger.info({ modelId }, 'Initializing CLIP engine (stub)')
    const engine: ClipEngine = {
        modelId,
        async embedImage(_input) {
            notConfigured(modelId, 'clip-image')
        },
        async embedText(_input) {
            notConfigured(modelId, 'clip-text')
        },
    }
    engines.set(modelId, engine)
    return engine
}

export async function embedImage(image: string, modelId: ClipModelId = DEFAULT_CLIP_MODEL): Promise<{
    vector: number[]
    modelId: ClipModelId
}> {
    const engine = await loadEngine(modelId)
    const vector = await engine.embedImage(image)
    return { vector, modelId }
}

export async function embedText(text: string, modelId: ClipModelId = DEFAULT_CLIP_MODEL): Promise<{
    vector: number[]
    modelId: ClipModelId
}> {
    const engine = await loadEngine(modelId)
    const vector = await engine.embedText(text)
    return { vector, modelId }
}

/** Reports which CLIP models have been touched / loaded this process. */
export function status(): Record<ClipModelId, 'loaded' | 'unavailable' | 'pending'> {
    return {
        'openclip-vit-b-32': engines.has('openclip-vit-b-32') ? 'loaded' : 'pending',
        'siglip-2': engines.has('siglip-2') ? 'loaded' : 'pending',
    }
}
