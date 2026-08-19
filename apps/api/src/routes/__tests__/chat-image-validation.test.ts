// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Characterization tests for the webchat image-validation guard.
 *
 * Pins the exact rules extracted from `routes/chat.ts` (max 5 images,
 * max 10MB, base64 data URL required, SVG rejected) so the extraction
 * into `application/chat/validateImages.ts` is provably behavior-preserving.
 * The route returns the same { code, message } 400 for each case.
 */

import { describe, it, expect } from 'vitest'
import { validateImages, MAX_IMAGE_BYTES } from '../../application/chat/validateImages.js'

const png = (extra: Partial<{ data: string; mimeType: string; name: string }> = {}) => ({
    data: 'data:image/png;base64,iVBORw0KGgo=',
    mimeType: 'image/png',
    name: 'x.png',
    ...extra,
})

describe('validateImages', () => {
    it('undefined images → ok, zero valid', () => {
        const r = validateImages(undefined)
        expect(r).toEqual({ ok: true, validImages: [] })
    })

    it('non-array images → ok, zero valid (route treats as none)', () => {
        const r = validateImages({ foo: 'bar' })
        expect(r).toEqual({ ok: true, validImages: [] })
    })

    it('single valid png → ok, echoed back', () => {
        const img = png()
        const r = validateImages([img])
        expect(r).toEqual({ ok: true, validImages: [img] })
    })

    it('multiple valid images pass through in order', () => {
        const imgs = [png({ name: 'a.png' }), png({ name: 'b.png' }), png({ name: 'c.png' })]
        const r = validateImages(imgs)
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.validImages.map((i) => i.name)).toEqual(['a.png', 'b.png', 'c.png'])
    })

    it('rejects > 5 images with TOO_MANY_IMAGES', () => {
        const r = validateImages(Array.from({ length: 6 }, () => png()))
        expect(r).toEqual({ ok: false, code: 'TOO_MANY_IMAGES', message: 'Maximum 5 images per message' })
    })

    it('exactly 5 images is allowed', () => {
        const r = validateImages(Array.from({ length: 5 }, () => png()))
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.validImages).toHaveLength(5)
    })

    it('rejects non-data-URL data with INVALID_IMAGE', () => {
        const r = validateImages([png({ data: 'https://example.com/x.png' })])
        expect(r).toEqual({ ok: false, code: 'INVALID_IMAGE', message: 'Images must be base64 data URLs (data:image/...)' })
    })

    it('rejects non-string data with INVALID_IMAGE', () => {
        const r = validateImages([{ data: 123, mimeType: 'image/png', name: 'x.png' }] as any)
        expect(r).toEqual({ ok: false, code: 'INVALID_IMAGE', message: 'Images must be base64 data URLs (data:image/...)' })
    })

    it('rejects data length > 10MB with IMAGE_TOO_LARGE', () => {
        const big = 'data:image/png;base64,' + 'A'.repeat(MAX_IMAGE_BYTES + 1)
        const r = validateImages([png({ data: big })])
        expect(r).toEqual({ ok: false, code: 'IMAGE_TOO_LARGE', message: 'Image too large (max 10MB)' })
    })

    it('data length exactly 10MB is allowed', () => {
        const exact = 'data:image/png;base64,' + 'A'.repeat(MAX_IMAGE_BYTES - 'data:image/png;base64,'.length)
        const r = validateImages([png({ data: exact })])
        expect(r.ok).toBe(true)
    })

    it('rejects SVG mimeType with INVALID_IMAGE (must go through text path)', () => {
        const r = validateImages([png({ data: 'data:image/svg+xml;base64,PHN2Zz4=', mimeType: 'image/svg+xml' })])
        expect(r).toEqual({ ok: false, code: 'INVALID_IMAGE', message: 'SVG must be sent as a text document, not an image' })
    })

    it('returns on the FIRST violation (too-many before per-image checks)', () => {
        const r = validateImages([
            ...Array.from({ length: 5 }, () => png()),
            png({ data: 'not-a-data-url' }),
        ])
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.code).toBe('TOO_MANY_IMAGES')
    })

    it('returns on the FIRST per-image violation (invalid before svg check on later item)', () => {
        const r = validateImages([png({ data: 'not-a-data-url' }), png({ mimeType: 'image/svg+xml' })])
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.code).toBe('INVALID_IMAGE')
        if (!r.ok) expect(r.message).toBe('Images must be base64 data URLs (data:image/...)')
    })
})