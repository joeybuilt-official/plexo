// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure attachment-validation predicates (Phase N / ADR 0009).
 *
 * Sized so any future channel (Twilio MMS, Discord, Slack file uploads) can
 * reuse the same validators. No I/O; no DB; testable in isolation.
 */

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024  // 25 MiB per file (Gmail's own limit)
export const MAX_TOTAL_BYTES_PER_MESSAGE = 50 * 1024 * 1024  // 50 MiB across all attachments in one message
export const MAX_ATTACHMENTS_PER_MESSAGE = 20

/** Extensions that are flat-out rejected regardless of MIME header — Vera's
 *  defense-in-depth list against operator-clicks-the-link footguns. */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
    'exe', 'bat', 'scr', 'msi', 'js', 'vbs', 'ps1', 'com', 'cmd',
    'pif', 'reg', 'lnk', 'iso', 'dmg', 'app', 'jar', 'wsf', 'hta',
])

/** MIME prefixes accepted into storage. Any MIME outside this set is rejected. */
export const ALLOWED_MIME_PREFIXES: readonly string[] = [
    'image/',
    'application/pdf',
    'text/',
    'application/json',
    'application/zip',
    'application/x-zip-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint',
    'application/vnd.oasis.opendocument.',
    'audio/',
    'video/',
]

export type AttachmentRejection =
    | { code: 'EXTENSION_BLOCKED'; ext: string }
    | { code: 'MIME_NOT_ALLOWED'; mime: string }
    | { code: 'SIZE_EXCEEDED'; sizeBytes: number; limit: number }
    | { code: 'COUNT_EXCEEDED'; count: number; limit: number }
    | { code: 'TOTAL_SIZE_EXCEEDED'; totalBytes: number; limit: number }
    | { code: 'MISSING_FILENAME' }
    | { code: 'MISSING_MIMETYPE' }

/** Extract the lowercase extension from a filename, with no leading dot. */
export function extOf(filename: string): string {
    const idx = filename.lastIndexOf('.')
    if (idx === -1 || idx === filename.length - 1) return ''
    return filename.slice(idx + 1).toLowerCase()
}

/** Single-attachment shape check. Pure. Returns null if accepted. */
export function validateSingleAttachment(input: {
    filename?: string
    mimeType?: string
    sizeBytes?: number
}): AttachmentRejection | null {
    if (!input.filename) return { code: 'MISSING_FILENAME' }
    if (!input.mimeType) return { code: 'MISSING_MIMETYPE' }
    const ext = extOf(input.filename)
    if (ext && BLOCKED_EXTENSIONS.has(ext)) {
        return { code: 'EXTENSION_BLOCKED', ext }
    }
    const mimeLower = input.mimeType.toLowerCase()
    if (!ALLOWED_MIME_PREFIXES.some((p) => mimeLower.startsWith(p))) {
        return { code: 'MIME_NOT_ALLOWED', mime: input.mimeType }
    }
    if (typeof input.sizeBytes === 'number' && input.sizeBytes > MAX_ATTACHMENT_BYTES) {
        return { code: 'SIZE_EXCEEDED', sizeBytes: input.sizeBytes, limit: MAX_ATTACHMENT_BYTES }
    }
    return null
}

/** Aggregate check across a candidate set. Returns null if accepted. */
export function validateAttachmentSet(items: ReadonlyArray<{ sizeBytes?: number }>): AttachmentRejection | null {
    if (items.length > MAX_ATTACHMENTS_PER_MESSAGE) {
        return { code: 'COUNT_EXCEEDED', count: items.length, limit: MAX_ATTACHMENTS_PER_MESSAGE }
    }
    const total = items.reduce((acc, it) => acc + (it.sizeBytes ?? 0), 0)
    if (total > MAX_TOTAL_BYTES_PER_MESSAGE) {
        return { code: 'TOTAL_SIZE_EXCEEDED', totalBytes: total, limit: MAX_TOTAL_BYTES_PER_MESSAGE }
    }
    return null
}
