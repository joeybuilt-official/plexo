// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/** 'image' = raster (jpeg/png/gif/webp), 'svg' = SVG text, 'pdf' = PDF binary */
export type FileKind = 'image' | 'svg' | 'pdf'

export interface PastedImage {
    id: string
    dataUrl: string
    mimeType: string
    name: string
    kind: FileKind
    /** For PDFs: text extracted by PDF.js. For SVG/raster: undefined. */
    extractedText?: string
}

export interface PastedDocument {
    id: string
    name: string
    content: string
    lineCount: number
    charCount: number
}

/**
 * Returns the FileKind from a MIME type.
 */
export function kindFromMime(mime: string): FileKind | null {
    if (mime === 'image/svg+xml') return 'svg'
    if (mime === 'application/pdf') return 'pdf'
    if (mime.startsWith('image/')) return 'image'
    return null
}

/**
 * Extracts PastedImage objects from a DataTransfer object.
 * Note: Does not perform dataUrl or text extraction.
 */
export function extractImagesFromDataTransfer(dt: DataTransfer): { id: string, file: File, kind: FileKind }[] {
    const items: { id: string, file: File, kind: FileKind }[] = []
    for (const item of Array.from(dt.items)) {
        const kind = kindFromMime(item.type)
        if (!kind) continue
        const file = item.getAsFile()
        if (!file) continue
        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2)}`
        items.push({ id, file, kind })
    }
    return items
}
