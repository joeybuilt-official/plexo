// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared parser for stored URLs (attachment_scan_queue.storage_url,
 * conversations.attachments[].url) into a key the storage package's
 * `getByKey` accepts.
 *
 * Extracted in Phase N+2 (ADR 0013) so the outbound resolver can reuse
 * the same parser the N+1 scan worker uses. Path-traversal guards mirror
 * those in `getByKey` itself — defense in depth.
 *
 *   s3://bucket/key/path  → { kind: 's3', key: 'key/path' }
 *   file:///abs/path      → { kind: 'file', key: '/abs/path' }
 *   bare key (no scheme)  → { kind: 'raw', key: storageUrl }
 */

export interface ParsedStorageKey {
    kind: 's3' | 'file' | 'raw'
    key: string
}

function rejectTraversal(value: string, label: string): void {
    if (value.includes('..') || value.includes('\0')) {
        throw new Error(`parseStorageKey: ${label}`)
    }
}

export function parseStorageKey(url: string): ParsedStorageKey {
    if (url.startsWith('s3://')) {
        const without = url.slice('s3://'.length)
        const slashIdx = without.indexOf('/')
        const key = slashIdx === -1 ? '' : without.slice(slashIdx + 1)
        rejectTraversal(key, 'invalid s3 key')
        return { kind: 's3', key }
    }
    if (url.startsWith('file://')) {
        const parsed = url.slice('file://'.length)
        rejectTraversal(parsed, 'invalid path')
        return { kind: 'file', key: parsed }
    }
    rejectTraversal(url, 'invalid raw key')
    return { kind: 'raw', key: url }
}
