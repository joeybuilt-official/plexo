// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// prepAnalyzeImage: the analyze-image source is transcoded to a JPEG data: URL
// BEFORE the model sees it, because Ollama/gemma3 cannot decode WebP (verified
// 2026-07-11: webp→400 "Failed to load image", jpeg→200). Undecodable/unfetchable
// sources fail PERMANENTLY (CallModelError CALL_MODEL_4XX → terminal 422).

import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { prepAnalyzeImage } from '../analyze-image-source.js'
import { CallModelError } from '@plexo/agent/providers/call-model'

const URL_ANY = new URL('https://example.test/preview.webp')

function mockFetchOnce(body: Buffer | null, init?: { ok?: boolean; status?: number }) {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: init?.ok ?? true,
        status: init?.status ?? 200,
        headers: new Headers(body ? { 'content-length': String(body.length) } : {}),
        arrayBuffer: async () => (body ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)),
    })))
}

afterEach(() => vi.unstubAllGlobals())

describe('prepAnalyzeImage', () => {
    it('transcodes a WebP source into a JPEG data: URL (the ollama-incompatible → compatible fix)', async () => {
        const webp = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 30, b: 30 } } }).webp().toBuffer()
        mockFetchOnce(webp)

        const dataUrl = await prepAnalyzeImage(URL_ANY)

        expect(dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
        const out = Buffer.from(dataUrl.slice('data:image/jpeg;base64,'.length), 'base64')
        const meta = await sharp(out).metadata()
        expect(meta.format).toBe('jpeg')
    })

    it('downscales the longest edge to <= 1024px', async () => {
        const big = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: { r: 10, g: 10, b: 10 } } }).webp().toBuffer()
        mockFetchOnce(big)

        const dataUrl = await prepAnalyzeImage(URL_ANY)
        const meta = await sharp(Buffer.from(dataUrl.split(',')[1] ?? '', 'base64')).metadata()
        expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1024)
    })

    it('throws a permanent CallModelError(4XX) on an undecodable source', async () => {
        mockFetchOnce(Buffer.from('not an image at all'))
        await expect(prepAnalyzeImage(URL_ANY)).rejects.toMatchObject({ code: 'CALL_MODEL_4XX' })
        await expect(prepAnalyzeImage(URL_ANY)).rejects.toBeInstanceOf(CallModelError)
    })

    it('throws a permanent CallModelError(4XX) on a non-2xx fetch', async () => {
        mockFetchOnce(null, { ok: false, status: 404 })
        await expect(prepAnalyzeImage(URL_ANY)).rejects.toMatchObject({ code: 'CALL_MODEL_4XX' })
    })
})
