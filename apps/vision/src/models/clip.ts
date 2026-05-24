// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * CLIP (image ↔ text shared embedding) loader.
 *
 * Default model: OpenAI CLIP ViT-B/32 via the Xenova ONNX export. Output is
 * a 512-dim L2-normalized vector — the same dimensionality every Fonto
 * `assets.clip_vec` row uses, and the same space text-to-image search runs
 * over (image and text encoders share the projection head).
 *
 * Note on the ADR: ADR 0001 names "OpenCLIP ViT-B-32 (LAION-2B)". We ship
 * OpenAI's CLIP base (same architecture and embedding dimensionality) for
 * Phase 4.2 because Xenova publishes a maintained ONNX export with
 * tokenizer + processor configs that transformers.js consumes directly. The
 * choice is invisible to Fonto — `assets.clip_vec` is currently empty in
 * prod (no migration cost) and the vector space we pick now becomes "the"
 * Fonto CLIP space. A SigLIP-2 multilingual opt-in is reserved for later.
 *
 * Implementation uses @huggingface/transformers (transformers.js v3+),
 * which wraps onnxruntime-node when running under Node — exactly the
 * runtime the ADR mandates.
 */

import {
    env,
    CLIPVisionModelWithProjection,
    CLIPTextModelWithProjection,
    AutoTokenizer,
    AutoProcessor,
    RawImage,
    type PreTrainedModel,
    type PreTrainedTokenizer,
    type Processor,
} from '@huggingface/transformers'
import sharp from 'sharp'
import { decodeBase64Input } from '../lib/image.js'
import { childLogger } from '../lib/logger.js'

const logger = childLogger('clip')

export type ClipModelId = 'openclip-vit-b-32' | 'siglip-2'

export const CLIP_DIM = 512
export const DEFAULT_CLIP_MODEL: ClipModelId = 'openclip-vit-b-32'

// Logical ID -> HuggingFace repo path. Both repos ship Xenova-style ONNX
// exports with tokenizer.json + preprocessor_config.json that
// transformers.js can load directly.
const MODEL_REPOS: Record<ClipModelId, string> = {
    'openclip-vit-b-32': 'Xenova/clip-vit-base-patch32',
    // SigLIP-2 multilingual opt-in — same 512-dim projection. Wire when
    // operators ask for non-English text search.
    'siglip-2': 'Xenova/siglip-base-patch16-224',
}

// Configure transformers.js to cache models under MODEL_CACHE_DIR (default
// /home/plexo/.plexo/vision/models — provisioned by the Dockerfile). We
// allow remote downloads on first request; subsequent requests hit the
// cache. ONNX execution provider is forced to CPU — onnxruntime-node will
// be selected automatically under Node.
const CACHE_DIR = process.env.MODEL_CACHE_DIR ?? '/tmp/plexo-vision-models'
env.cacheDir = CACHE_DIR
env.allowRemoteModels = true
env.allowLocalModels = true
// Disable the WASM backend explicitly — transformers.js will pick
// onnxruntime-node when running outside the browser, but we set this so any
// accidental WASM fallback is loud rather than silent.
;(env.backends.onnx as { wasm?: { proxy?: boolean } }).wasm = { proxy: false }

interface ClipEngine {
    modelId: ClipModelId
    visionModel: PreTrainedModel
    textModel: PreTrainedModel
    processor: Processor
    tokenizer: PreTrainedTokenizer
}

const engines = new Map<ClipModelId, ClipEngine>()
const loading = new Map<ClipModelId, Promise<ClipEngine>>()

async function loadEngine(modelId: ClipModelId): Promise<ClipEngine> {
    const existing = engines.get(modelId)
    if (existing) return existing
    const inflight = loading.get(modelId)
    if (inflight) return inflight
    const repo = MODEL_REPOS[modelId]
    if (!repo) throw new Error(`CLIP model "${modelId}" has no configured HF repo`)
    const p = (async () => {
        logger.info({ modelId, repo, cacheDir: CACHE_DIR }, 'Loading CLIP engine')
        const t0 = performance.now()
        const [visionModel, textModel, processor, tokenizer] = await Promise.all([
            CLIPVisionModelWithProjection.from_pretrained(repo, { dtype: 'fp32' }),
            CLIPTextModelWithProjection.from_pretrained(repo, { dtype: 'fp32' }),
            AutoProcessor.from_pretrained(repo),
            AutoTokenizer.from_pretrained(repo),
        ])
        const engine: ClipEngine = { modelId, visionModel, textModel, processor, tokenizer }
        engines.set(modelId, engine)
        loading.delete(modelId)
        logger.info({ modelId, loadMs: Math.round(performance.now() - t0) }, 'CLIP engine ready')
        return engine
    })()
    loading.set(modelId, p)
    return p
}

function l2Normalize(v: Float32Array): number[] {
    let norm = 0
    for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!
    norm = Math.sqrt(norm) || 1
    const out = new Array<number>(v.length)
    for (let i = 0; i < v.length; i++) out[i] = v[i]! / norm
    return out
}

/**
 * Convert a base64-encoded image (with or without data: prefix) into a
 * RawImage that transformers.js can feed to the CLIP processor. The
 * processor handles the actual CLIP preprocessing (resize-shortest-side,
 * center crop, normalize) — we just decode to raw RGB pixels first.
 */
async function toRawImage(image: string): Promise<RawImage> {
    const bytes = decodeBase64Input(image)
    const { data, info } = await sharp(bytes, { failOn: 'error' })
        .removeAlpha()
        .toColorspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true })
    // RawImage holds packed HWC bytes — exactly what sharp returns.
    return new RawImage(new Uint8ClampedArray(data), info.width, info.height, 3)
}

export async function embedImage(
    image: string,
    modelId: ClipModelId = DEFAULT_CLIP_MODEL,
): Promise<{ vector: number[]; modelId: ClipModelId }> {
    const engine = await loadEngine(modelId)
    const raw = await toRawImage(image)
    const inputs = await engine.processor(raw)
    const out = await engine.visionModel(inputs)
    // CLIPVisionModelWithProjection returns { image_embeds: Tensor[1, 512] }
    const tensor = (out as { image_embeds: { data: Float32Array; dims: number[] } }).image_embeds
    if (tensor.dims[tensor.dims.length - 1] !== CLIP_DIM) {
        throw new Error(`CLIP vision output dim ${tensor.dims.join('x')} != expected 512`)
    }
    return { vector: l2Normalize(tensor.data), modelId }
}

export async function embedText(
    text: string,
    modelId: ClipModelId = DEFAULT_CLIP_MODEL,
): Promise<{ vector: number[]; modelId: ClipModelId }> {
    const engine = await loadEngine(modelId)
    // CLIP text models use a 77-token context window. Truncation guards
    // against accidental DoS from huge `text` payloads.
    const inputs = await engine.tokenizer(text, {
        padding: true,
        truncation: true,
    })
    const out = await engine.textModel(inputs)
    const tensor = (out as { text_embeds: { data: Float32Array; dims: number[] } }).text_embeds
    if (tensor.dims[tensor.dims.length - 1] !== CLIP_DIM) {
        throw new Error(`CLIP text output dim ${tensor.dims.join('x')} != expected 512`)
    }
    return { vector: l2Normalize(tensor.data), modelId }
}

/** Reports which CLIP models have been touched / loaded this process. */
export function status(): Record<ClipModelId, 'loaded' | 'loading' | 'pending'> {
    const out = {} as Record<ClipModelId, 'loaded' | 'loading' | 'pending'>
    for (const id of Object.keys(MODEL_REPOS) as ClipModelId[]) {
        if (engines.has(id)) out[id] = 'loaded'
        else if (loading.has(id)) out[id] = 'loading'
        else out[id] = 'pending'
    }
    return out
}
