// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Image decode + preprocessing helpers built on `sharp`.
 *
 * All route handlers accept the same input shape: a base64-encoded image
 * payload or a `data:image/...;base64,...` URL. This module:
 *
 *   - parses either form into a Buffer,
 *   - decodes via sharp,
 *   - resizes / center-crops / normalizes into the layout each model wants
 *     (CHW float32 for CLIP, ArcFace; HWC uint8 for detection / OCR).
 *
 * The actual transforms required by each model live in the model loader
 * files (src/models/*.ts) — this file only provides the primitives.
 */

import sharp from 'sharp'

const DATA_URL_RE = /^data:image\/[a-zA-Z+.-]+;base64,(.+)$/

/** Parse a base64 string or data URL into raw bytes. */
export function decodeBase64Input(input: string): Buffer {
    if (!input || typeof input !== 'string') {
        throw new Error('image: input must be a base64 string or data URL')
    }
    const match = input.match(DATA_URL_RE)
    const b64 = match ? match[1]! : input
    try {
        return Buffer.from(b64, 'base64')
    } catch {
        throw new Error('image: invalid base64')
    }
}

export interface DecodedImage {
    /** Raw pixel data — layout depends on the `channels` field. */
    data: Buffer
    width: number
    height: number
    /** 3 = RGB, 4 = RGBA. */
    channels: 3 | 4
}

/** Decode + resize to a fixed size, returning HWC uint8 pixels in RGB. */
export async function decodeToRGB(
    input: string,
    opts: { width?: number; height?: number; fit?: 'cover' | 'contain' } = {},
): Promise<DecodedImage> {
    const bytes = decodeBase64Input(input)
    let pipeline = sharp(bytes, { failOn: 'error' }).removeAlpha().toColorspace('srgb')
    if (opts.width || opts.height) {
        pipeline = pipeline.resize(opts.width ?? null, opts.height ?? null, {
            fit: opts.fit ?? 'cover',
        })
    }
    const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })
    return { data, width: info.width, height: info.height, channels: 3 }
}

/**
 * Decode and produce a CHW float32 tensor normalized with per-channel
 * mean/std. This is the standard preprocessing for CLIP, ArcFace and most
 * ImageNet-pretrained models — the exact mean/std values vary by model and
 * are passed in by the caller.
 *
 * Returns a Float32Array of length 3*H*W laid out C[H[W]].
 */
export async function decodeToCHWFloat(
    input: string,
    opts: {
        width: number
        height: number
        mean: [number, number, number]
        std: [number, number, number]
        fit?: 'cover' | 'contain'
    },
): Promise<Float32Array> {
    const img = await decodeToRGB(input, { width: opts.width, height: opts.height, fit: opts.fit })
    const { data, width, height } = img
    const out = new Float32Array(3 * width * height)
    // sharp returns HWC (RGB). Re-layout to CHW + normalize.
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const hwc = (y * width + x) * 3
            const r = data[hwc]! / 255
            const g = data[hwc + 1]! / 255
            const b = data[hwc + 2]! / 255
            const pixIdx = y * width + x
            out[0 * width * height + pixIdx] = (r - opts.mean[0]) / opts.std[0]
            out[1 * width * height + pixIdx] = (g - opts.mean[1]) / opts.std[1]
            out[2 * width * height + pixIdx] = (b - opts.mean[2]) / opts.std[2]
        }
    }
    return out
}

/** Crop a bbox [x, y, w, h] out of a decoded image, returning raw bytes. */
export async function cropToBuffer(
    input: string,
    bbox: [number, number, number, number],
): Promise<Buffer> {
    const bytes = decodeBase64Input(input)
    const [x, y, w, h] = bbox
    return sharp(bytes)
        .extract({ left: Math.round(x), top: Math.round(y), width: Math.round(w), height: Math.round(h) })
        .toBuffer()
}
