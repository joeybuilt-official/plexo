// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import type { WorkRendererProps } from '../types'

/**
 * ImageRenderer — displays a raster or SVG image. For SVG we inline the
 * content as a data URL so agent-produced SVGs render without needing an
 * uploaded URL. For other formats we use `work.url` (served by the
 * assets API).
 */
export function ImageRenderer({ work }: WorkRendererProps) {
    const ext = (work.filename.split('.').pop() || '').toLowerCase()
    let src = work.url ?? ''

    if (ext === 'svg' && work.content) {
        src = `data:image/svg+xml;utf8,${encodeURIComponent(work.content)}`
    }

    if (!src) {
        return (
            <div className="h-full flex items-center justify-center text-sm text-text-muted italic">
                No image source available.
            </div>
        )
    }

    return (
        <div className="w-full h-full bg-surface-1 flex items-center justify-center p-8 overflow-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt={work.filename} className="max-w-full max-h-full object-contain" />
        </div>
    )
}
