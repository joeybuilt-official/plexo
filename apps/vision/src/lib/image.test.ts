// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for the colourspace-safe image primitives (root-cause fix for the
 * `vips_colourspace: no known route from 'multiband' to 'srgb'` failures).
 *
 * The multiband reinterpretation logic (bandsToRgb) and the routability gate
 * (isRoutableToSrgb) are pure and tested here without libvips. openSrgb's
 * fast path is smoke-tested against a real sharp-encoded image. The
 * non-routable branch is verified end-to-end against a genuine multiband TIFF
 * on the real libvips build in the container (see PR notes) — that path can't
 * be manufactured with sharp's encoders, which normalize to sRGB on write.
 */

import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { bandsToRgb, isRoutableToSrgb, openSrgb } from './image.js'

describe('isRoutableToSrgb', () => {
    it('routes standard spaces + band counts via the fast path', () => {
        expect(isRoutableToSrgb('srgb', 3)).toBe(true)
        expect(isRoutableToSrgb('srgb', 4)).toBe(true)
        expect(isRoutableToSrgb('b-w', 1)).toBe(true)
        expect(isRoutableToSrgb('cmyk', 4)).toBe(true)
        expect(isRoutableToSrgb(undefined, undefined)).toBe(true)
    })

    it('rejects multiband and non-standard band counts (no libvips route)', () => {
        expect(isRoutableToSrgb('multiband', 3)).toBe(false) // production culprit
        expect(isRoutableToSrgb('srgb', 5)).toBe(false) // odd band count
        expect(isRoutableToSrgb('srgb', 2)).toBe(false) // grey+alpha-ish
        expect(isRoutableToSrgb('srgb', 6)).toBe(false)
    })
})

describe('bandsToRgb', () => {
    it('maps the first three of ≥3 bands to R,G,B (drops extras)', () => {
        // 2 px, 5 bands each: [10,20,30,40,50], [60,70,80,90,100]
        const data = Uint8Array.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
        const out = bandsToRgb(data, 2, 1, 5)
        expect([...out]).toEqual([10, 20, 30, 60, 70, 80])
    })

    it('replicates the luma band for 1–2 band (greyscale) inputs', () => {
        // 2 px, 2 bands (grey + alpha): grey should fill R,G,B; alpha dropped
        const data = Uint8Array.from([128, 255, 64, 0])
        const out = bandsToRgb(data, 2, 1, 2)
        expect([...out]).toEqual([128, 128, 128, 64, 64, 64])
    })

    it('passes 3-band RGB through unchanged', () => {
        const data = Uint8Array.from([1, 2, 3, 4, 5, 6])
        const out = bandsToRgb(data, 2, 1, 3)
        expect([...out]).toEqual([1, 2, 3, 4, 5, 6])
    })
})

describe('openSrgb', () => {
    it('fast path: a normal RGB image yields 3-band sRGB pixels', async () => {
        const png = await sharp({
            create: { width: 4, height: 2, channels: 3, background: { r: 10, g: 20, b: 30 } },
        }).png().toBuffer()
        const { data, info } = await (await openSrgb(png)).raw().toBuffer({ resolveWithObject: true })
        expect(info.channels).toBe(3)
        expect(info.width).toBe(4)
        expect(info.height).toBe(2)
        expect(data.length).toBe(4 * 2 * 3)
        expect([data[0], data[1], data[2]]).toEqual([10, 20, 30])
    })
})
