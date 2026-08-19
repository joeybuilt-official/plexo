// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { isChunkLoadError } from '../chunk-load-error'

describe('isChunkLoadError', () => {
    it('matches an error whose name is ChunkLoadError', () => {
        const err = new Error('boom')
        err.name = 'ChunkLoadError'
        expect(isChunkLoadError(err)).toBe(true)
    })

    it('matches the production "Failed to load chunk … from module" message', () => {
        expect(
            isChunkLoadError(
                new Error('Failed to load chunk /_next/static/chunks/1x8jmy6m0dbaw.js from module'),
            ),
        ).toBe(true)
    })

    it('matches "Loading chunk N failed"', () => {
        expect(isChunkLoadError(new Error('Loading chunk 42 failed.'))).toBe(true)
    })

    it('matches a failed dynamic import', () => {
        expect(
            isChunkLoadError(new Error('error loading dynamically imported module: /x.js')),
        ).toBe(true)
    })

    it('does not match an unrelated runtime error', () => {
        expect(
            isChunkLoadError(new Error("Cannot read properties of undefined (reading 'id')")),
        ).toBe(false)
    })
})
