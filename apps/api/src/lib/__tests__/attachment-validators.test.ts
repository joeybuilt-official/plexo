// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import {
    validateSingleAttachment,
    validateAttachmentSet,
    extOf,
    BLOCKED_EXTENSIONS,
    ALLOWED_MIME_PREFIXES,
    MAX_ATTACHMENT_BYTES,
    MAX_TOTAL_BYTES_PER_MESSAGE,
    MAX_ATTACHMENTS_PER_MESSAGE,
} from '../attachment-validators.js'

describe('extOf', () => {
    it('lowercase extension without leading dot', () => {
        expect(extOf('Receipt.PDF')).toBe('pdf')
        expect(extOf('photo.JPG')).toBe('jpg')
    })
    it('returns empty string when no extension', () => {
        expect(extOf('Makefile')).toBe('')
        expect(extOf('photo.')).toBe('')
        expect(extOf('')).toBe('')
    })
    it('handles double extensions (uses last)', () => {
        expect(extOf('archive.tar.gz')).toBe('gz')
    })
})

describe('validateSingleAttachment — accepts (Phase N)', () => {
    it('PDF receipt', () => {
        expect(validateSingleAttachment({ filename: 'receipt.pdf', mimeType: 'application/pdf', sizeBytes: 200_000 })).toBeNull()
    })
    it('PNG image', () => {
        expect(validateSingleAttachment({ filename: 'photo.png', mimeType: 'image/png', sizeBytes: 800_000 })).toBeNull()
    })
    it('plain text note', () => {
        expect(validateSingleAttachment({ filename: 'notes.txt', mimeType: 'text/plain', sizeBytes: 1024 })).toBeNull()
    })
    it('docx office document', () => {
        expect(validateSingleAttachment({
            filename: 'memo.docx',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 50_000,
        })).toBeNull()
    })
})

describe('validateSingleAttachment — rejects', () => {
    it('blocks .exe regardless of MIME', () => {
        const r = validateSingleAttachment({ filename: 'innocent.exe', mimeType: 'application/pdf', sizeBytes: 1024 })
        expect(r?.code).toBe('EXTENSION_BLOCKED')
    })
    it('blocks .bat / .scr / .msi / .js / .vbs / .ps1', () => {
        for (const ext of ['bat', 'scr', 'msi', 'js', 'vbs', 'ps1']) {
            const r = validateSingleAttachment({ filename: `a.${ext}`, mimeType: 'image/png', sizeBytes: 100 })
            expect(r?.code).toBe('EXTENSION_BLOCKED')
        }
    })
    it('blocks .iso / .dmg', () => {
        for (const ext of ['iso', 'dmg']) {
            const r = validateSingleAttachment({ filename: `disk.${ext}`, mimeType: 'application/octet-stream', sizeBytes: 100 })
            expect(r?.code).toBe('EXTENSION_BLOCKED')
        }
    })
    it('rejects unknown MIME', () => {
        const r = validateSingleAttachment({ filename: 'weird.bin', mimeType: 'application/x-suspicious', sizeBytes: 100 })
        expect(r?.code).toBe('MIME_NOT_ALLOWED')
    })
    it('rejects oversize (>25 MiB)', () => {
        const r = validateSingleAttachment({ filename: 'big.pdf', mimeType: 'application/pdf', sizeBytes: MAX_ATTACHMENT_BYTES + 1 })
        expect(r?.code).toBe('SIZE_EXCEEDED')
    })
    it('rejects missing filename / mimeType', () => {
        expect(validateSingleAttachment({ mimeType: 'image/png' })?.code).toBe('MISSING_FILENAME')
        expect(validateSingleAttachment({ filename: 'a.png' })?.code).toBe('MISSING_MIMETYPE')
    })
})

describe('validateAttachmentSet', () => {
    it('accepts an empty set', () => {
        expect(validateAttachmentSet([])).toBeNull()
    })
    it('accepts within count + total caps', () => {
        const items = Array.from({ length: 3 }, () => ({ sizeBytes: 1_000_000 }))
        expect(validateAttachmentSet(items)).toBeNull()
    })
    it('rejects too many attachments', () => {
        const items = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => ({ sizeBytes: 100 }))
        expect(validateAttachmentSet(items)?.code).toBe('COUNT_EXCEEDED')
    })
    it('rejects total size > 50 MiB', () => {
        const items = Array.from({ length: 3 }, () => ({ sizeBytes: 20 * 1024 * 1024 }))
        expect(validateAttachmentSet(items)?.code).toBe('TOTAL_SIZE_EXCEEDED')
    })
})

describe('constants — defensive sanity', () => {
    it('blocked extension list includes the canonical Windows-malware-vehicle set', () => {
        for (const ext of ['exe', 'bat', 'scr', 'msi', 'js', 'vbs', 'ps1', 'com', 'cmd']) {
            expect(BLOCKED_EXTENSIONS.has(ext)).toBe(true)
        }
    })
    it('MIME allow-list covers the common operator-forwarded types', () => {
        const allTogether = ALLOWED_MIME_PREFIXES.join(' ')
        expect(allTogether).toContain('image/')
        expect(allTogether).toContain('application/pdf')
        expect(allTogether).toContain('text/')
    })
    it('per-message total is at least 2x per-attachment cap', () => {
        expect(MAX_TOTAL_BYTES_PER_MESSAGE).toBeGreaterThanOrEqual(2 * MAX_ATTACHMENT_BYTES)
    })
})
