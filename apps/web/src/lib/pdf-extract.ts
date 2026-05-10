// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Client-side PDF text extraction using PDF.js.
 *
 * Extracts all text content from a PDF data URL and returns it as a
 * plain string. Pages are separated by a horizontal rule so the model
 * can see the page structure.
 *
 * Worker is loaded from cdnjs to avoid bundling the ~900 KB worker
 * into the app chunk. The version pin must match the installed pdfjs-dist.
 */

const PDFJS_VERSION = '5.5.207'
const WORKER_SRC = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.mjs`

let workerConfigured = false

async function getPdfJs() {
    // Dynamic import — keeps pdfjs-dist out of the initial bundle
    const pdfjs = await import('pdfjs-dist')
    if (!workerConfigured) {
        pdfjs.GlobalWorkerOptions.workerSrc = WORKER_SRC
        workerConfigured = true
    }
    return pdfjs
}

export interface PdfExtractResult {
    text: string
    pageCount: number
    /** True if extraction succeeded; false if it fell back to a stub message */
    ok: boolean
}

/**
 * Extract readable text from a PDF given as a base64 data URL.
 * Never throws — returns `ok: false` with a stub message on failure.
 */
export async function extractPdfText(dataUrl: string): Promise<PdfExtractResult> {
    try {
        const pdfjs = await getPdfJs()

        // Turn data URL into a Uint8Array
        const base64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
        const raw = atob(base64)
        const bytes = new Uint8Array(raw.length)
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)

        const doc = await pdfjs.getDocument({ data: bytes }).promise
        const pageCount = doc.numPages
        const parts: string[] = []

        for (let p = 1; p <= pageCount; p++) {
            const page = await doc.getPage(p)
            const content = await page.getTextContent()
            const pageText = content.items
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .map((item: any) => ('str' in item ? item.str : ''))
                .join(' ')
                .replace(/\s{3,}/g, '\n')
                .trim()

            if (pageText) {
                parts.push(pageCount > 1 ? `[Page ${p}]\n${pageText}` : pageText)
            }
        }

        const text = parts.join('\n\n---\n\n')

        return {
            text: text || '(No readable text found in this PDF — it may be scanned/image-only.)',
            pageCount,
            ok: true,
        }
    } catch (err) {
        console.warn('[pdf-extract] extraction failed:', err)
        return {
            text: '(PDF text extraction failed. The file may be corrupted, password-protected, or image-only.)',
            pageCount: 0,
            ok: false,
        }
    }
}
