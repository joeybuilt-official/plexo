// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Object/scene labelling via the same Ollama-hosted vision-language model
 * that backs OCR (see ./ocr.ts). Where OCR transcribes text, this asks the
 * VLM to name the salient objects, scenes, and concepts in a photo — the
 * "things" signal Fonto surfaces as auto-tags.
 *
 * Selection lever: `OLLAMA_URL` (shared with OCR). Unset → 503
 * model_unavailable, same as OCR. Model name: `OLLAMA_LABEL_MODEL`, falling
 * back to `OLLAMA_OCR_MODEL`, falling back to `qwen2.5vl:7b`.
 *
 * Output: a deduped list of short lowercase labels. The VLM is prompted for
 * a JSON array; we parse defensively (JSON first, then a bracket/comma
 * fallback) so a chatty model doesn't break ingest.
 */

import sharp from 'sharp'
import { childLogger } from '../lib/logger.js'
import { decodeBase64Input, openSrgb } from '../lib/image.js'

const logger = childLogger('label')

export const LABEL_MODEL_ID = 'qwen2.5vl:7b'

const LABEL_INPUT_MAX_EDGE = 1024
const LABEL_INPUT_JPEG_QUALITY = 85
const LABEL_TIMEOUT_MS = 300_000
const MAX_LABELS = 8
const MAX_LABEL_LEN = 32

const LABEL_PROMPT =
    'Look at this image and list the main objects, scenes, animals, and concepts you see. ' +
    'Respond with ONLY a JSON array of 3 to 8 short lowercase labels, each one or two words ' +
    '(for example: ["dog","beach","sunset","golden retriever"]). ' +
    'No prose, no markdown, no keys — just the array. ' +
    'If nothing is identifiable, output [].'

async function downsize(base64: string): Promise<string> {
    const bytes = decodeBase64Input(base64)
    const meta = await sharp(bytes, { failOn: 'error' }).metadata()
    const w = meta.width ?? 0
    const h = meta.height ?? 0
    if (w <= LABEL_INPUT_MAX_EDGE && h <= LABEL_INPUT_MAX_EDGE) return base64
    const resized = await (await openSrgb(bytes))
        .removeAlpha()
        .resize(LABEL_INPUT_MAX_EDGE, LABEL_INPUT_MAX_EDGE, {
            fit: 'inside',
            withoutEnlargement: true,
        })
        .jpeg({ quality: LABEL_INPUT_JPEG_QUALITY })
        .toBuffer()
    return resized.toString('base64')
}

function normalizeLabels(values: unknown[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const v of values) {
        if (typeof v !== 'string') continue
        const label = v.toLowerCase().trim().replace(/[."']+$/g, '').slice(0, MAX_LABEL_LEN)
        if (!label || seen.has(label)) continue
        seen.add(label)
        out.push(label)
        if (out.length >= MAX_LABELS) break
    }
    return out
}

/** Parse the VLM's free-form reply into a label list. */
function parseLabels(raw: string): string[] {
    const trimmed = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')
    // Preferred: a clean JSON array.
    try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) return normalizeLabels(parsed)
    } catch {
        // fall through
    }
    // Fallback: grab the first bracketed span and split on commas.
    const m = trimmed.match(/\[([\s\S]*?)\]/)
    const body = m?.[1] ?? trimmed
    const parts = body
        .split(/[,\n]/)
        .map((s) => s.replace(/["'\[\]]/g, '').trim())
        .filter(Boolean)
    return normalizeLabels(parts)
}

interface LabelEngine {
    label(image: string): Promise<string[]>
    modelId: string
}

let engine: LabelEngine | null = null
let loadingPromise: Promise<LabelEngine> | null = null

function notConfigured(): never {
    throw new Error(
        'Labelling not configured — set OLLAMA_URL (and optionally OLLAMA_LABEL_MODEL) ' +
            'on the plexo-vision container to enable VLM labelling.',
    )
}

async function loadEngine(): Promise<LabelEngine> {
    if (engine) return engine
    if (loadingPromise) return loadingPromise
    loadingPromise = (async () => {
        const ollamaUrl = process.env.OLLAMA_URL
        if (!ollamaUrl) {
            engine = {
                modelId: LABEL_MODEL_ID,
                async label() {
                    notConfigured()
                },
            }
            loadingPromise = null
            return engine
        }
        const modelId =
            process.env.OLLAMA_LABEL_MODEL ?? process.env.OLLAMA_OCR_MODEL ?? LABEL_MODEL_ID
        logger.info({ ollamaUrl, modelId }, 'Label engine using Ollama VLM')
        engine = {
            modelId,
            async label(image) {
                const t0 = performance.now()
                const downsized = await downsize(image)
                const controller = new AbortController()
                const timer = setTimeout(() => controller.abort(), LABEL_TIMEOUT_MS)
                try {
                    const resp = await fetch(`${ollamaUrl.replace(/\/+$/, '')}/api/generate`, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({
                            model: modelId,
                            prompt: LABEL_PROMPT,
                            images: [downsized],
                            stream: false,
                            keep_alive: '30m',
                            options: { temperature: 0, num_ctx: 4096, num_predict: 256 },
                        }),
                        signal: controller.signal,
                    })
                    if (!resp.ok) {
                        const detail = await resp.text().catch(() => '')
                        throw new Error(
                            `ollama HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
                        )
                    }
                    const data = (await resp.json()) as { response?: string }
                    const labels = parseLabels(data.response ?? '')
                    logger.info(
                        { ms: Math.round(performance.now() - t0), count: labels.length, modelId },
                        'label call completed',
                    )
                    return labels
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

export async function label(image: string): Promise<{ labels: string[]; modelId: string }> {
    const e = await loadEngine()
    const labels = await e.label(image)
    return { labels, modelId: e.modelId }
}
