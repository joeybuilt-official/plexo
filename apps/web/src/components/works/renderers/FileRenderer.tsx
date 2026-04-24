// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { FileText } from 'lucide-react'

import type { WorkRendererProps } from '../types'

/**
 * FileRenderer — fallback for opaque binary or unknown-kind works. Shows
 * filename + size. Download is provided by the panel header.
 */
export function FileRenderer({ work }: WorkRendererProps) {
    const sizeLabel = work.bytes < 1024
        ? `${work.bytes}B`
        : work.bytes < 1024 * 1024
            ? `${(work.bytes / 1024).toFixed(1)}KB`
            : `${(work.bytes / (1024 * 1024)).toFixed(1)}MB`

    return (
        <div className="h-full flex flex-col items-center justify-center gap-3 p-8 text-center text-text-muted bg-[#0d0d0d]">
            <FileText className="h-10 w-10 text-text-muted/50" />
            <div>
                <h3 className="text-text-secondary font-medium mb-1">{work.filename}</h3>
                <p className="text-xs">{sizeLabel}</p>
                <p className="text-xs mt-2">Preview isn&apos;t available for this file type. Use Download.</p>
            </div>
        </div>
    )
}
