// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Draft attachments — Phase N+2 (ADR 0013 §D9).
 *
 * Upload a file to MinIO under `drafts/{conversationId}/{contentHash}-{filename}`
 * so the agent (or a future direct-reply UI) can reference it by contentHash
 * when composing an outbound Gmail multipart reply.
 *
 *   POST /api/v1/conversations/:conversationId/draft-attachments
 *   Content-Type: multipart/form-data
 *   Body: single `file` field
 *
 *   200 → { contentHash, filename, mimeType, sizeBytes, storageUrl }
 *   404 → { error, code: 'not_found' }            (conversation not in workspace)
 *   413 → { error, code: 'size_exceeded' }
 *   415 → { error, code: 'mime_blocked' | 'extension_blocked' }
 *   400 → { error, code: 'no_file' | 'parse_failed' }
 *
 * MinIO lifecycle requirement (Phase N+2 — manual setup):
 *   The `drafts/` prefix MUST be configured to expire objects after 24h.
 *   This is NOT plumbed automatically. Apply it once via `mc`:
 *     mc ilm rule add --expire-days 1 --prefix drafts/ plexo/plexo-assets
 *   Or via the MinIO console: Bucket → plexo-assets → Lifecycle → Add rule
 *   with prefix=drafts/, action=expire current version after 1 day.
 *   Without this, draft uploads accumulate indefinitely.
 */

import { Router, type Router as RouterType } from 'express'
import express from 'express'
import { createHash } from 'node:crypto'
import * as draftAttachmentsRepo from '../repositories/draft-attachments.repository.js'
import { uploadToKey } from '@plexo/storage'
import {
    validateSingleAttachment,
    MAX_ATTACHMENT_BYTES,
} from '../lib/attachment-validators.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const draftAttachmentsRouter: RouterType = Router({ mergeParams: true })

interface ParsedPart {
    name: string
    filename?: string
    contentType?: string
    data: Buffer
}

/** Minimal RFC 7578 multipart/form-data parser for a single-file upload.
 *  Only supports the parts we need: text fields and one file part with
 *  `Content-Disposition: form-data; name="file"; filename="…"`.
 *  Line endings: assumes CRLF per RFC 7578 §4.1; LF-only bodies (non-
 *  standard clients) will fail to parse — all major browsers send CRLF. */
function parseMultipart(body: Buffer, boundary: string): ParsedPart[] {
    const dashBoundary = Buffer.from(`--${boundary}`)
    const crlf = Buffer.from('\r\n')
    const parts: ParsedPart[] = []

    let cursor = body.indexOf(dashBoundary)
    if (cursor < 0) return parts
    cursor += dashBoundary.length

    while (cursor < body.length) {
        // End boundary `--boundary--` terminates the body
        if (body[cursor] === 0x2d /* '-' */ && body[cursor + 1] === 0x2d) break
        // Skip CRLF after boundary
        if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2

        // Headers section ends at the first \r\n\r\n
        const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
        if (headerEnd < 0) break
        const rawHeaders = body.slice(cursor, headerEnd).toString('utf8')
        cursor = headerEnd + 4

        // Next boundary marks end of this part's body
        const nextBoundary = body.indexOf(dashBoundary, cursor)
        if (nextBoundary < 0) break
        // Strip the trailing \r\n that precedes the boundary
        const dataEnd = body[nextBoundary - 2] === 0x0d ? nextBoundary - 2 : nextBoundary
        const data = body.slice(cursor, dataEnd)

        const headers: Record<string, string> = {}
        for (const line of rawHeaders.split(crlf.toString())) {
            const colon = line.indexOf(':')
            if (colon < 0) continue
            headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
        }
        const cd = headers['content-disposition'] ?? ''
        const nameMatch = cd.match(/name="([^"]*)"/)
        const fnMatch = cd.match(/filename="([^"]*)"/)
        if (nameMatch && nameMatch[1] !== undefined) {
            parts.push({
                name: nameMatch[1],
                filename: fnMatch?.[1],
                contentType: headers['content-type'],
                data,
            })
        }

        cursor = nextBoundary + dashBoundary.length
    }
    return parts
}

function extractBoundary(contentType: string | undefined): string | null {
    if (!contentType) return null
    const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
    if (!m) return null
    const raw = m[1] ?? m[2]
    return raw ? raw.trim() : null
}

/** Conservative filename sanitizer — same allowlist used by inbound. */
function sanitizeFilename(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
}

const RAW_LIMIT_BYTES = MAX_ATTACHMENT_BYTES + 1 * 1024 * 1024 // +1 MiB for boundary/header overhead

draftAttachmentsRouter.post(
    '/',
    express.raw({ type: 'multipart/form-data', limit: RAW_LIMIT_BYTES }),
    async (req, res) => {
        // mergeParams=true surfaces the parent route's :conversationId, but
        // the Router's generic param type stays `{}`. Read via the typed cast.
        const conversationId = (req.params as Record<string, string | undefined>).conversationId
        if (!conversationId || conversationId.length > 64) {
            res.status(400).json({ error: 'invalid conversationId', code: 'invalid_id' })
            return
        }

        // Conversation lookup → workspace check
        const conv = await draftAttachmentsRepo.getConversationForAttachment(conversationId)
        if (!conv) {
            res.status(404).json({ error: 'Conversation not found', code: 'not_found' })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, conv.workspaceId)) return

        // Multipart parse
        const boundary = extractBoundary(req.headers['content-type'])
        if (!boundary) {
            res.status(400).json({ error: 'missing multipart boundary', code: 'parse_failed' })
            return
        }
        if (!Buffer.isBuffer(req.body)) {
            res.status(400).json({ error: 'expected raw multipart body', code: 'parse_failed' })
            return
        }
        let parts: ParsedPart[]
        try {
            parts = parseMultipart(req.body as Buffer, boundary)
        } catch (err) {
            logger.warn({ err, conversationId }, 'draft-attachments: multipart parse failed')
            res.status(400).json({ error: 'malformed multipart body', code: 'parse_failed' })
            return
        }
        const filePart = parts.find((p) => p.name === 'file' && p.filename && p.data.length > 0)
        if (!filePart) {
            res.status(400).json({ error: 'no file field in multipart body', code: 'no_file' })
            return
        }

        const filename = filePart.filename!
        const mimeType = filePart.contentType ?? 'application/octet-stream'
        const sizeBytes = filePart.data.length

        // Validate against the shared allow-list / blocklist
        const reject = validateSingleAttachment({ filename, mimeType, sizeBytes })
        if (reject) {
            switch (reject.code) {
                case 'EXTENSION_BLOCKED':
                    res.status(415).json({ error: `extension .${reject.ext} not allowed`, code: 'extension_blocked' })
                    return
                case 'MIME_NOT_ALLOWED':
                    res.status(415).json({ error: `mime ${reject.mime} not allowed`, code: 'mime_blocked' })
                    return
                case 'SIZE_EXCEEDED':
                    res.status(413).json({ error: `file exceeds ${reject.limit} bytes`, code: 'size_exceeded' })
                    return
                case 'MISSING_FILENAME':
                case 'MISSING_MIMETYPE':
                    res.status(400).json({ error: 'filename and mimeType required', code: 'no_file' })
                    return
                default:
                    res.status(400).json({ error: 'attachment rejected', code: 'invalid' })
                    return
            }
        }

        // Hash + store
        const contentHash = createHash('sha256').update(filePart.data).digest('hex')
        const safeFilename = sanitizeFilename(filename)
        const key = `drafts/${conversationId}/${contentHash}-${safeFilename}`

        let storageUrl: string
        try {
            const upload = await uploadToKey({ key, content: filePart.data, contentType: mimeType })
            storageUrl = upload.url
        } catch (err) {
            logger.error({ err, conversationId, contentHash }, 'draft-attachments: storage upload failed')
            res.status(500).json({ error: 'storage upload failed', code: 'storage_failed' })
            return
        }

        // Append to conversations.attachments — preserve any prior entries.
        // The new shape carries `draft: true` (Phase N+2 schema extension) so
        // downstream code can distinguish operator-staged drafts from inbound.
        const newAttachment = {
            url: storageUrl,
            type: mimeType,
            filename,
            sizeBytes,
            contentHash,
            scanStatus: 'unscanned' as const,
            draft: true,
        }
        try {
            await draftAttachmentsRepo.appendAttachment(conversationId, newAttachment)
        } catch (err) {
            // Don't fail the upload — the file is in MinIO and the contentHash
            // is the durable handle. Worst case: the conversation row lacks
            // the chip. Log + continue.
            logger.warn({ err, conversationId, contentHash }, 'draft-attachments: failed to append to conversations.attachments (non-fatal)')
        }

        // Enqueue clamd scan — UNIQUE(content_hash) dedupes if this hash was
        // already enqueued for an inbound attachment. Failure is non-fatal.
        try {
            await draftAttachmentsRepo.enqueueScan({
                workspaceId: conv.workspaceId,
                conversationId,
                contentHash,
                storageUrl,
                mimeType,
                sizeBytes,
            })
        } catch (err) {
            logger.warn({ err, contentHash }, 'draft-attachments: enqueueScan failed (non-fatal)')
        }

        res.status(200).json({
            contentHash,
            filename,
            mimeType,
            sizeBytes,
            storageUrl,
        })
    },
)
