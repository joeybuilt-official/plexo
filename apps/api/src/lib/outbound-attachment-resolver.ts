// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Outbound attachment resolver — Phase N+2 (ADR 0013).
 *
 * Two source modes converge on a uniform `ResolvedAttachment[]`:
 *   - forward-mode: agent passes `{contentHash}`; bytes pulled from MinIO.
 *   - upload-mode: agent passes base64 inline; bytes decoded + validated.
 *
 * Validation gates (per ADR 0013 §D5 / §D10):
 *   - count cap (10) and total-bytes cap (25 MiB) across the call.
 *   - per-attachment MIME allow-list + extension blocklist (mirrors §D5
 *     of ADR 0009 via `attachment-validators.ts`).
 *   - forward-mode: workspace match (pre-mortem #3) + scanStatus gate
 *     (pre-mortem #5; re-checked at send-time, not compose-time).
 *
 * Audit emits go through `emitAttachmentOutboundBlocked` per rejection.
 * Successful resolution does NOT emit `attachment.sent` — the caller
 * does that after the actual transport completes.
 */

import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { getByKey } from '@plexo/storage'
import { createHash } from 'node:crypto'
import {
    BLOCKED_EXTENSIONS,
    ALLOWED_MIME_PREFIXES,
    extOf,
    validateSingleAttachment,
} from './attachment-validators.js'
import { parseStorageKey } from './storage-key.js'
import { logger } from '../logger.js'

const MAX_OUTBOUND_ATTACHMENTS = 10
const MAX_OUTBOUND_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_SINGLE_OUTBOUND_BYTES = 25 * 1024 * 1024

export type ForwardAttachment = { contentHash: string }
export type UploadAttachment = { filename: string; mimeType: string; bytesBase64: string }
export type AttachmentInput = ForwardAttachment | UploadAttachment

export interface ResolvedAttachment {
    filename: string
    mimeType: string
    bytes: Buffer
    sizeBytes: number
    contentHash?: string
    sourceConversationId?: string
    source: 'forward' | 'upload'
}

export interface ResolveContext {
    workspaceId: string
    operatorUserId?: string
    auditEmit: (event: string, payload: Record<string, unknown>) => Promise<void>
}

export interface ResolveResult {
    ok: boolean
    resolved?: ResolvedAttachment[]
    error?: string
    rejected?: Array<{ index: number; reason: string }>
}

interface ConversationAttachmentRow {
    id: string
    workspace_id: string
    attachments: Array<{
        url?: string
        type?: string
        alt?: string
        filename?: string
        sizeBytes?: number
        contentHash?: string
        scanStatus?: 'unscanned' | 'clean' | 'infected' | 'error'
        signature?: string
    }>
    [k: string]: unknown
}

function isUploadInput(input: AttachmentInput): input is UploadAttachment {
    return 'bytesBase64' in input && typeof (input as UploadAttachment).bytesBase64 === 'string'
}

function isForwardInput(input: AttachmentInput): input is ForwardAttachment {
    return 'contentHash' in input && typeof (input as ForwardAttachment).contentHash === 'string'
}

/**
 * Strict-ish base64 sanity check: re-encode the decoded buffer and
 * compare lengths after stripping whitespace + padding from the input.
 * Rejects truncated / mid-stream-corrupted strings without depending on
 * Node's permissive `Buffer.from` behaviour.
 */
function decodedLengthMatches(rawBase64: string, decoded: Buffer): boolean {
    const stripped = rawBase64.replace(/\s+/g, '')
    const padded = stripped.replace(/=+$/, '')
    const expectedBytes = Math.floor((padded.length * 3) / 4)
    return decoded.length === expectedBytes
}

async function lookupConversationsByContentHashes(
    contentHashes: string[],
): Promise<Map<string, ConversationAttachmentRow>> {
    const out = new Map<string, ConversationAttachmentRow>()
    if (contentHashes.length === 0) return out
    const dedup = Array.from(new Set(contentHashes))
    const conditions = dedup.map(
        (h) => sql`attachments @> jsonb_build_array(jsonb_build_object('contentHash', ${h}::text))`,
    )
    const rows = await db.execute<ConversationAttachmentRow>(sql`
        SELECT id, workspace_id, attachments
        FROM conversations
        WHERE ${sql.join(conditions, sql` OR `)}
    `)
    const list = Array.isArray(rows)
        ? rows
        : ((rows as unknown as { rows?: ConversationAttachmentRow[] }).rows ?? [])
    for (const row of list) {
        for (const att of row.attachments) {
            if (att.contentHash && dedup.includes(att.contentHash) && !out.has(att.contentHash)) {
                out.set(att.contentHash, row)
            }
        }
    }
    return out
}

async function resolveForward(
    input: ForwardAttachment,
    ctx: ResolveContext,
    row: ConversationAttachmentRow | null,
): Promise<{ ok: true; value: ResolvedAttachment } | { ok: false; reason: string }> {
    if (!row) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason: 'not_found',
        })
        return { ok: false, reason: 'not_found' }
    }
    if (row.workspace_id !== ctx.workspaceId) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason: 'cross_workspace',
        })
        return { ok: false, reason: 'cross_workspace' }
    }

    const att = row.attachments.find((a) => a.contentHash === input.contentHash)
    if (!att) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason: 'not_found',
        })
        return { ok: false, reason: 'not_found' }
    }

    const status = att.scanStatus ?? 'unscanned'
    if (status === 'infected') {
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason: 'infected',
            filename: att.filename,
            sizeBytes: att.sizeBytes,
        })
        return { ok: false, reason: 'infected' }
    }
    if (status === 'unscanned' || status === 'error') {
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason: 'pending_approval',
            filename: att.filename,
            sizeBytes: att.sizeBytes,
        })
        return { ok: false, reason: 'pending_approval' }
    }

    if (!att.url || !att.filename || !att.type) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason: 'metadata_incomplete',
        })
        return { ok: false, reason: 'metadata_incomplete' }
    }

    const perItemReject = validateSingleAttachment({
        filename: att.filename,
        mimeType: att.type,
        sizeBytes: att.sizeBytes,
    })
    if (perItemReject) {
        const reasonMap: Record<string, string> = {
            EXTENSION_BLOCKED: 'extension_blocked',
            MIME_NOT_ALLOWED: 'mime_blocked',
            SIZE_EXCEEDED: 'size_exceeded',
            MISSING_FILENAME: 'metadata_incomplete',
            MISSING_MIMETYPE: 'metadata_incomplete',
        }
        const reason = reasonMap[perItemReject.code] ?? 'rejected'
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason,
            filename: att.filename,
            sizeBytes: att.sizeBytes,
        })
        return { ok: false, reason }
    }

    let bytes: Buffer
    try {
        const parsed = parseStorageKey(att.url)
        bytes = await getByKey(parsed.key)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ err, contentHash: input.contentHash }, 'outbound-resolver: forward fetch failed')
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason: 'fetch_failed',
            filename: att.filename,
        })
        return { ok: false, reason: `fetch_failed: ${msg}` }
    }

    if (bytes.length > MAX_SINGLE_OUTBOUND_BYTES) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            contentHash: input.contentHash,
            reason: 'size_exceeded',
            filename: att.filename,
            sizeBytes: bytes.length,
        })
        return { ok: false, reason: 'size_exceeded' }
    }

    return {
        ok: true,
        value: {
            filename: att.filename,
            mimeType: att.type,
            bytes,
            sizeBytes: bytes.length,
            contentHash: input.contentHash,
            sourceConversationId: row.id,
            source: 'forward',
        },
    }
}

async function resolveUpload(
    input: UploadAttachment,
    ctx: ResolveContext,
): Promise<{ ok: true; value: ResolvedAttachment } | { ok: false; reason: string }> {
    if (!input.filename || !input.mimeType) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            reason: 'metadata_incomplete',
            filename: input.filename,
        })
        return { ok: false, reason: 'metadata_incomplete' }
    }

    const ext = extOf(input.filename)
    if (ext && BLOCKED_EXTENSIONS.has(ext)) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            reason: 'extension_blocked',
            filename: input.filename,
        })
        return { ok: false, reason: 'extension_blocked' }
    }

    const mimeLower = input.mimeType.toLowerCase()
    if (!ALLOWED_MIME_PREFIXES.some((p) => mimeLower.startsWith(p))) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            reason: 'mime_blocked',
            filename: input.filename,
        })
        return { ok: false, reason: 'mime_blocked' }
    }

    let bytes: Buffer
    try {
        bytes = Buffer.from(input.bytesBase64, 'base64')
    } catch {
        await ctx.auditEmit('attachment.outbound_blocked', {
            reason: 'invalid_base64',
            filename: input.filename,
        })
        return { ok: false, reason: 'invalid_base64' }
    }

    if (!decodedLengthMatches(input.bytesBase64, bytes)) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            reason: 'invalid_base64',
            filename: input.filename,
        })
        return { ok: false, reason: 'invalid_base64' }
    }

    if (bytes.length > MAX_SINGLE_OUTBOUND_BYTES) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            reason: 'size_exceeded',
            filename: input.filename,
            sizeBytes: bytes.length,
        })
        return { ok: false, reason: 'size_exceeded' }
    }

    const contentHash = createHash('sha256').update(bytes).digest('hex')
    logger.info(
        { workspaceId: ctx.workspaceId, filename: input.filename, sizeBytes: bytes.length, contentHash },
        'outbound-resolver: upload-mode resolved',
    )

    return {
        ok: true,
        value: {
            filename: input.filename,
            mimeType: input.mimeType,
            bytes,
            sizeBytes: bytes.length,
            source: 'upload',
        },
    }
}

export async function resolveOutboundAttachments(
    inputs: AttachmentInput[],
    ctx: ResolveContext,
): Promise<ResolveResult> {
    if (inputs.length === 0) {
        return { ok: true, resolved: [] }
    }

    if (inputs.length > MAX_OUTBOUND_ATTACHMENTS) {
        await ctx.auditEmit('attachment.outbound_blocked', {
            reason: 'count_exceeded',
        })
        return { ok: false, error: 'count_exceeded' }
    }

    const forwardHashes = inputs
        .filter(isForwardInput)
        .map((i) => i.contentHash)
    const rowsByHash = await lookupConversationsByContentHashes(forwardHashes)

    const resolved: ResolvedAttachment[] = []
    const rejected: Array<{ index: number; reason: string }> = []
    let runningTotalBytes = 0

    for (let i = 0; i < inputs.length; i += 1) {
        const input = inputs[i]!
        let outcome: { ok: true; value: ResolvedAttachment } | { ok: false; reason: string }

        if (isForwardInput(input)) {
            outcome = await resolveForward(input, ctx, rowsByHash.get(input.contentHash) ?? null)
        } else if (isUploadInput(input)) {
            outcome = await resolveUpload(input, ctx)
        } else {
            await ctx.auditEmit('attachment.outbound_blocked', {
                reason: 'invalid_input_shape',
            })
            outcome = { ok: false, reason: 'invalid_input_shape' }
        }

        if (!outcome.ok) {
            rejected.push({ index: i, reason: outcome.reason })
            return {
                ok: false,
                error: outcome.reason,
                rejected,
                resolved,
            }
        }

        runningTotalBytes += outcome.value.sizeBytes
        if (runningTotalBytes > MAX_OUTBOUND_TOTAL_BYTES) {
            await ctx.auditEmit('attachment.outbound_blocked', {
                reason: 'total_size_exceeded',
                contentHash: outcome.value.contentHash,
                filename: outcome.value.filename,
                sizeBytes: outcome.value.sizeBytes,
            })
            rejected.push({ index: i, reason: 'total_size_exceeded' })
            return {
                ok: false,
                error: 'total_size_exceeded',
                rejected,
                resolved,
            }
        }

        resolved.push(outcome.value)
    }

    return { ok: true, resolved }
}
