// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * analyze-image source gateway: fetch the source image and hand the vision
 * model a JPEG data: URL.
 *
 * WHY this exists (2026-07-11): the local Ollama vision path (gemma3 /
 * qwen2.5vl via the OpenAI-compat endpoint) CANNOT decode WebP — it returns
 * 400 "Failed to load image or audio file" (verified: webp→400, jpeg/png→200).
 * Fonto previews are WebP, so every analyze call 400'd. We also must NOT hand
 * the AI-SDK a bare http URL: `@ai-sdk/openai-compatible` declares no
 * `supportedUrls`, so the SDK downloads the bytes onto the V8 heap and
 * base64-inlines them — uncapped, a driver of the heap-OOM crash loop. sharp
 * decodes/resizes in NATIVE memory (off the V8 heap) and emits a small JPEG:
 * decodable format + bounded heap in one step.
 *
 * Kept in its own module (no `@plexo/agent` planner/db transitive imports) so
 * the transcode is unit-testable without booting the whole route graph.
 */

import sharp from 'sharp'
import { CallModelError } from '@plexo/agent/providers/call-model'

const ANALYZE_FETCH_TIMEOUT_MS = 20_000
const ANALYZE_MAX_FETCH_BYTES = 64 * 1024 * 1024 // reject absurd originals before decode
const ANALYZE_MAX_EDGE_PX = 1024                  // downscale longest edge for the VLM

/**
 * Throws CallModelError(CALL_MODEL_4XX) on an unfetchable/undecodable source —
 * a PERMANENT condition the caller maps to a terminal 422 (no retry).
 */
export async function prepAnalyzeImage(url: URL): Promise<string> {
    let resp: Response
    try {
        resp = await fetch(url, { signal: AbortSignal.timeout(ANALYZE_FETCH_TIMEOUT_MS) })
    } catch (err) {
        throw new CallModelError(`analyze-image source fetch failed: ${(err as Error).message}`, 'CALL_MODEL_4XX', err)
    }
    if (!resp.ok) {
        throw new CallModelError(`analyze-image source fetch HTTP ${resp.status}`, 'CALL_MODEL_4XX')
    }
    const declared = Number(resp.headers.get('content-length') ?? '0')
    if (declared > ANALYZE_MAX_FETCH_BYTES) {
        throw new CallModelError(`analyze-image source exceeds ${ANALYZE_MAX_FETCH_BYTES} bytes`, 'CALL_MODEL_4XX')
    }
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length === 0) throw new CallModelError('analyze-image source is empty', 'CALL_MODEL_4XX')
    if (buf.length > ANALYZE_MAX_FETCH_BYTES) {
        throw new CallModelError(`analyze-image source exceeds ${ANALYZE_MAX_FETCH_BYTES} bytes`, 'CALL_MODEL_4XX')
    }
    let jpeg: Buffer
    try {
        jpeg = await sharp(buf, { failOn: 'none' })
            .rotate() // bake EXIF orientation in before jpeg output strips metadata
            .resize(ANALYZE_MAX_EDGE_PX, ANALYZE_MAX_EDGE_PX, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer()
    } catch (err) {
        throw new CallModelError(`analyze-image could not decode source image: ${(err as Error).message}`, 'CALL_MODEL_4XX', err)
    }
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}
