// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0013 — multipart-builder unit tests.
 * Hand-rolled minimal MIME parser inline (~70 LOC) to avoid pulling
 * mailparser as a dev dep for these golden-file checks.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildMime, type BuildMimeAttachment } from '../multipart-builder.js'

const CRLF = '\r\n'

interface ParsedMime {
    topHeaders: Record<string, string>
    boundary: string | null
    parts: Array<{ headers: Record<string, string>; body: string }>
    rawBody: string
}

function parseHeaders(block: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const line of block.split(CRLF)) {
        const idx = line.indexOf(':')
        if (idx === -1) continue
        const k = line.slice(0, idx).trim().toLowerCase()
        const v = line.slice(idx + 1).trim()
        out[k] = v
    }
    return out
}

function parseMime(raw: string): ParsedMime {
    const sep = raw.indexOf(CRLF + CRLF)
    const headerBlock = raw.slice(0, sep)
    const body = raw.slice(sep + 4)
    const topHeaders = parseHeaders(headerBlock)

    const ct = topHeaders['content-type'] ?? ''
    const m = ct.match(/boundary="?([^";\s]+)"?/i)
    const boundary = m ? m[1]! : null

    if (!boundary) {
        return { topHeaders, boundary: null, parts: [{ headers: topHeaders, body }], rawBody: body }
    }

    const delim = `--${boundary}`
    const segments = body.split(delim)
    const parts: Array<{ headers: Record<string, string>; body: string }> = []
    for (const seg of segments) {
        // skip preamble (before first delim) and epilogue (--<boundary>--)
        if (seg === '' || seg.startsWith('--')) continue
        let s = seg
        // each part is preceded/followed by CRLF — trim leading CRLF
        if (s.startsWith(CRLF)) s = s.slice(2)
        // strip trailing CRLF before the closing delim
        if (s.endsWith(CRLF)) s = s.slice(0, -2)
        const innerSep = s.indexOf(CRLF + CRLF)
        if (innerSep === -1) continue
        parts.push({
            headers: parseHeaders(s.slice(0, innerSep)),
            body: s.slice(innerSep + 4),
        })
    }
    return { topHeaders, boundary, parts, rawBody: body }
}

function decodeBase64Part(body: string): Buffer {
    return Buffer.from(body.replace(/\r?\n/g, ''), 'base64')
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n%bytes-go-here\n%%EOF\n', 'utf8')
const PNG_BYTES = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IHDR-stub-payload-bytes', 'utf8'),
])

const baseParams = {
    from: 'agent@plexo.test',
    to: 'recipient@example.com',
    subject: 'Subject Line',
    bodyText: 'Hello world body text.',
}

describe('buildMime — single text part (no attachments)', () => {
    it('emits text/plain, no boundary', () => {
        const result = buildMime({ ...baseParams })
        expect(result.boundary).toBeNull()
        expect(result.raw).toContain('Content-Type: text/plain; charset=utf-8')
        expect(result.raw).toContain('MIME-Version: 1.0')
        expect(result.raw).toContain('Hello world body text.')
        expect(result.raw).not.toMatch(/multipart/i)
    })
})

describe('buildMime — one PDF attachment', () => {
    it('produces multipart/mixed with body + decoded PDF part', () => {
        const att: BuildMimeAttachment = {
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            bytes: PDF_BYTES,
        }
        const result = buildMime({ ...baseParams, attachments: [att] })
        expect(result.boundary).toBeTruthy()
        expect(result.raw.toLowerCase()).toContain('content-type: multipart/mixed')

        const parsed = parseMime(result.raw)
        expect(parsed.parts).toHaveLength(2)

        const textPart = parsed.parts[0]!
        expect(textPart.headers['content-type']).toMatch(/text\/plain/)
        expect(textPart.body).toBe(baseParams.bodyText)

        const filePart = parsed.parts[1]!
        expect(filePart.headers['content-type']).toMatch(/application\/pdf/)
        expect(filePart.headers['content-disposition']).toMatch(
            /attachment; filename="report\.pdf"/,
        )
        expect(filePart.headers['content-transfer-encoding']).toBe('base64')
        const decoded = decodeBase64Part(filePart.body)
        expect(decoded.equals(PDF_BYTES)).toBe(true)
    })
})

describe('buildMime — two attachments (PDF + PNG)', () => {
    it('emits 3 parts; each round-trips', () => {
        const result = buildMime({
            ...baseParams,
            attachments: [
                { filename: 'report.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES },
                { filename: 'photo.png', mimeType: 'image/png', bytes: PNG_BYTES },
            ],
        })
        const parsed = parseMime(result.raw)
        expect(parsed.parts).toHaveLength(3)

        expect(parsed.parts[0]!.body).toBe(baseParams.bodyText)

        expect(parsed.parts[1]!.headers['content-type']).toMatch(/application\/pdf/)
        expect(decodeBase64Part(parsed.parts[1]!.body).equals(PDF_BYTES)).toBe(true)

        expect(parsed.parts[2]!.headers['content-type']).toMatch(/image\/png/)
        expect(decodeBase64Part(parsed.parts[2]!.body).equals(PNG_BYTES)).toBe(true)
    })
})

describe('buildMime — filename quoting', () => {
    it('safe ASCII filename: bare token in double-quotes', () => {
        const result = buildMime({
            ...baseParams,
            attachments: [{ filename: 'simple.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES }],
        })
        expect(result.raw).toContain('filename="simple.pdf"')
    })

    it('filename with spaces falls through to RFC 2231 encoded form', () => {
        const result = buildMime({
            ...baseParams,
            attachments: [
                { filename: 'my report.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES },
            ],
        })
        // current impl uses encodeURIComponent path when not SAFE_FILENAME
        expect(result.raw).toMatch(/filename\*=UTF-8''my%20report\.pdf/)
    })

    it('non-ASCII filename uses RFC 2231 percent-encoded form', () => {
        const result = buildMime({
            ...baseParams,
            attachments: [
                { filename: 'résumé.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES },
            ],
        })
        expect(result.raw).toMatch(/filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf/)
    })
})

describe('buildMime — boundary uniqueness', () => {
    it('50 builds produce 50 unique boundaries', () => {
        const seen = new Set<string>()
        for (let i = 0; i < 50; i++) {
            const r = buildMime({
                ...baseParams,
                bodyText: `body-${i}`,
                attachments: [{ filename: `f${i}.pdf`, mimeType: 'application/pdf', bytes: PDF_BYTES }],
            })
            expect(r.boundary).toBeTruthy()
            seen.add(r.boundary!)
        }
        expect(seen.size).toBe(50)
    })
})

describe('buildMime — boundary collision', () => {
    it('chosen boundary never appears in body text or attachment bytes', () => {
        const r = buildMime({
            ...baseParams,
            bodyText: 'arbitrary body text',
            attachments: [
                { filename: 'r.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES },
            ],
        })
        expect(r.boundary).toBeTruthy()
        expect(r.boundary!.startsWith('=_Part_')).toBe(true)
        expect('arbitrary body text'.includes(r.boundary!)).toBe(false)
        expect(PDF_BYTES.includes(Buffer.from(r.boundary!, 'utf8'))).toBe(false)
    })

    it('body containing the literal collision-detection format does not break parsing', () => {
        // Body that contains a string LOOKING like a boundary — impl should
        // still produce a parseable multipart message.
        const fakeBoundary = '=_Part_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        const r = buildMime({
            ...baseParams,
            bodyText: `text containing ${fakeBoundary} marker`,
            attachments: [
                { filename: 'r.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES },
            ],
        })
        expect(r.boundary).not.toBe(fakeBoundary)
        const parsed = parseMime(r.raw)
        expect(parsed.parts).toHaveLength(2)
        // Suppress unused-import warning for vi
        expect(typeof vi).toBe('object')
    })
})

describe('buildMime — top-level MIME-Version', () => {
    it('always present (single part)', () => {
        expect(buildMime({ ...baseParams }).raw).toContain('MIME-Version: 1.0')
    })
    it('always present (multipart)', () => {
        const r = buildMime({
            ...baseParams,
            attachments: [{ filename: 'r.pdf', mimeType: 'application/pdf', bytes: PDF_BYTES }],
        })
        expect(r.raw).toContain('MIME-Version: 1.0')
    })
})

describe('buildMime — In-Reply-To / References preserved', () => {
    it('passes through inReplyTo (auto-wraps with <>)', () => {
        const r = buildMime({ ...baseParams, inReplyTo: 'abc@example.com' })
        expect(r.raw).toContain('In-Reply-To: <abc@example.com>')
        expect(r.raw).toContain('References: <abc@example.com>')
    })
    it('preserves caller-provided angle brackets', () => {
        const r = buildMime({ ...baseParams, inReplyTo: '<def@example.com>' })
        expect(r.raw).toContain('In-Reply-To: <def@example.com>')
        expect(r.raw).toContain('References: <def@example.com>')
    })
})
