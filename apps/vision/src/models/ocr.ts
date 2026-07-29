// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * OCR via an Ollama-hosted vision-language model.
 *
 * Phase 4.4 plan was PaddleOCR PP-OCRv5 ONNX — three models (det + cls +
 * rec), DB-NMS, perspective warp, CTC decoding, char-dictionary lookup.
 * Hundreds of lines of postprocessing with ample edge cases. A VLM gets
 * us text extraction in a single HTTP call with quality that's at parity
 * or better on natural-scene photos (the common Fonto case), at the cost
 * of higher per-image latency on CPU.
 *
 * Selection lever: `OLLAMA_URL` env var. Unset → loader fast-fails with
 * "not configured" and routes return 503 (same behaviour as the Phase
 * 4.1 bootstrap). Set → routes call `${OLLAMA_URL}/api/generate` on the
 * model named by `OLLAMA_OCR_MODEL` (default `qwen2.5vl:7b`).
 *
 * Response shape: we split the VLM's prose output on newlines, returning
 * one `OcrLine` per non-empty line. Bbox is `[0, 0, 0, 0]` and confidence
 * is `1.0` per line — the VLM doesn't emit either, but Fonto's
 * `lib/plexo-vision.ts ocrImage()` requires the `OcrLine` shape, and
 * `lib/plexo.ts plexoVisionOcr()` joins line text by newlines, so the
 * round-trip preserves the original layout intent.
 */

import sharp from 'sharp'
import { childLogger } from '../lib/logger.js'
import { decodeBase64Input, openSrgb } from '../lib/image.js'

const logger = childLogger('ocr')

export const OCR_MODEL_ID = 'qwen2.5vl:7b'

// Qwen2.5-VL's vision encoder tiles the input image into a fixed patch
// grid; running it against a 3000×4000 phone photo doesn't yield more
// useful signal than a 1024×1024 downscaled version, and CPU inference
// scales linearly with input pixel count. Cap the long edge at 1024 px
// before sending to Ollama: the 3 OCR failures seen on the first prod
// backfill were timeouts on 1080+ px previews. JPEG q85 keeps the payload
// small without softening text edges enough to hurt recognition.
const OCR_INPUT_MAX_EDGE = 1024
const OCR_INPUT_JPEG_QUALITY = 85

async function downsizeForOcr(base64: string): Promise<string> {
    const bytes = decodeBase64Input(base64)
    const meta = await sharp(bytes, { failOn: 'error' }).metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (w <= OCR_INPUT_MAX_EDGE && h <= OCR_INPUT_MAX_EDGE) {
        // Already small enough — pass through unchanged. Saves a sharp
        // round-trip + re-encode for screenshots / thumbnails / tiny
        // uploads.
        return base64
    }
    const resized = await (await openSrgb(bytes))
        .removeAlpha()
        .resize(OCR_INPUT_MAX_EDGE, OCR_INPUT_MAX_EDGE, {
            fit: 'inside',
            withoutEnlargement: true,
        })
        .jpeg({ quality: OCR_INPUT_JPEG_QUALITY })
        .toBuffer()
    return resized.toString('base64')
}

// Qwen2.5-VL 7B on CPU regularly takes 60–180 s/image and the 3B variant
// 20–40 s; the earlier 60 s cap aborted nearly every 7B call on the server. Cap
// at 5 min so a wedged Ollama process eventually fails the call but real
// cold-cache runs and high-detail prompts don't trip the abort. Fonto's
// own OCR_TIMEOUT_MS is also bumped to 300 s; this envelope just guards
// against Ollama hanging indefinitely on the upstream side.
const OCR_TIMEOUT_MS = 300_000
const OCR_PROMPT =
    'Extract all visible text from this image, preserving line breaks exactly as they appear. ' +
    'Output ONLY the extracted text — no preamble, no explanation, no markdown. ' +
    'If the image contains no readable text, output the literal token NO_TEXT and nothing else.'

export interface OcrLine {
    /** Single line of text from the source image. */
    text: string
    /** `[x, y, w, h]` in source-image pixel space. VLM OCR returns no boxes
     * — kept as a synthetic `[0, 0, 0, 0]` so the consumer's schema is
     * still satisfied. */
    bbox: [number, number, number, number]
    /** 0..1 recognizer confidence. VLM OCR returns no confidence —
     * reported as 1.0 to indicate "model accepted the line". */
    confidence: number
}

interface OcrEngine {
    /** Run OCR. `image` is base64 (no data: prefix). */
    recognize(image: string, lang: string): Promise<OcrLine[]>
    /** Stable id of the underlying model — passed through to Fonto. */
    modelId: string
}

let engine: OcrEngine | null = null
let loadingPromise: Promise<OcrEngine> | null = null

function notConfigured(): never {
    throw new Error(
        'OCR not configured — set OLLAMA_URL (and optionally OLLAMA_OCR_MODEL) ' +
            'on the plexo-vision container to enable VLM OCR.',
    )
}

async function loadEngine(): Promise<OcrEngine> {
    if (engine) return engine
    if (loadingPromise) return loadingPromise
    loadingPromise = (async () => {
        const ollamaUrl = process.env.OLLAMA_URL
        if (!ollamaUrl) {
            // Match the bootstrap-phase behaviour: each recognize() call
            // throws the "not configured" sentinel, which the route maps
            // to 503 model_unavailable.
            engine = {
                modelId: OCR_MODEL_ID,
                async recognize() {
                    notConfigured()
                },
            }
            loadingPromise = null
            return engine
        }
        const modelId = process.env.OLLAMA_OCR_MODEL ?? OCR_MODEL_ID
        logger.info({ ollamaUrl, modelId }, 'OCR engine using Ollama VLM')
        engine = {
            modelId,
            async recognize(image, _lang) {
                const t0 = performance.now()
                // Downsize before serializing — measured ~3-4× faster on
                // 2-4 MP camera previews. The metadata read+resize cost
                // is ~50 ms vs minutes saved on the VLM side.
                const downsized = await downsizeForOcr(image)
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), OCR_TIMEOUT_MS)
                try {
                    const resp = await fetch(
                        `${ollamaUrl.replace(/\/+$/, '')}/api/generate`,
                        {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({
                                model: modelId,
                                prompt: OCR_PROMPT,
                                images: [downsized],
                                stream: false,
                                // keep_alive 30 m so subsequent calls in
                                // a backfill don't pay the 30-60 s warm
                                // load on each invocation.
                                keep_alive: '30m',
                                options: {
                                    // OCR is a deterministic
                                    // transcription task, not generation.
                                    temperature: 0,
                                    // Cap context at 4096. Ollama's
                                    // default is 32 k, which inflates the
                                    // KV-cache to ~10 GB and forces a
                                    // CPU fallback even on 12 GB GPUs.
                                    // The OCR prompt is ~150 tokens and
                                    // we cap responses well under 2 k —
                                    // 4 k is more than enough headroom
                                    // and lets the 7B model fit fully on
                                    // a single RTX 3060.
                                    num_ctx: 4096,
                                    num_predict: 2048,
                                },
                            }),
                            signal: controller.signal,
                        },
                    )
                    if (!resp.ok) {
                        const detail = await resp.text().catch(() => '')
                        throw new Error(
                            `ollama HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
                        )
                    }
                    const data = (await resp.json()) as { response?: string }
                    const raw = (data.response ?? '').trim()
                    logger.info(
                        {
                            ms: Math.round(performance.now() - t0),
                            chars: raw.length,
                            modelId,
                        },
                        'OCR call completed',
                    )
                    if (!raw || raw === 'NO_TEXT') return []
                    const lines = raw
                        .split('\n')
                        .map((l) => l.trim())
                        .filter((l) => l.length > 0 && l !== 'NO_TEXT')
                        .map<OcrLine>((text) => ({
                            text,
                            bbox: [0, 0, 0, 0],
                            confidence: 1.0,
                        }))
                    return lines
                } finally {
                    clearTimeout(timer)
                }
            },
        }
        loadingPromise = null
        return engine
    })()
    return loadingPromise
}

export async function recognize(
    image: string,
    lang = 'en',
): Promise<{ lines: OcrLine[]; modelId: string }> {
    const e = await loadEngine()
    const lines = await e.recognize(image, lang)
    return { lines, modelId: e.modelId }
}

export function status(): { ocr: 'loaded' | 'loading' | 'pending' } {
    if (engine) return { ocr: 'loaded' }
    if (loadingPromise) return { ocr: 'loading' }
    return { ocr: 'pending' }
}
