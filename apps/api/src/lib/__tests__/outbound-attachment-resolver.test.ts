// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0013 — outbound attachment resolver unit tests.
 *
 * Mocks @plexo/db (`db.execute` returns canned conversation rows) and
 * @plexo/storage (`getByKey` returns synthetic Buffers). Audit emit is
 * supplied via the resolver's ctx.auditEmit hook.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeConversationRow {
    id: string
    workspace_id: string
    attachments: Array<{
        url?: string
        type?: string
        filename?: string
        sizeBytes?: number
        contentHash?: string
        scanStatus?: 'unscanned' | 'clean' | 'infected' | 'error'
    }>
}

const state = {
    convs: [] as FakeConversationRow[],
    storage: new Map<string, Buffer>(),
}

vi.mock('@plexo/db', () => {
    const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })
    sqlTag.raw = (s: string) => ({ raw: s })
    sqlTag.join = (parts: unknown[], sep: unknown) => ({ join: parts, sep })

    function collectValues(node: unknown, out: unknown[]): void {
        if (node === null || node === undefined) return
        if (typeof node === 'string' || typeof node === 'number') { out.push(node); return }
        if (Array.isArray(node)) { for (const x of node) collectValues(x, out); return }
        if (typeof node === 'object') {
            const o = node as Record<string, unknown>
            if ('values' in o) collectValues(o.values, out)
            if ('join' in o) collectValues(o.join, out)
        }
    }

    const execute = vi.fn(async (q: { strings: TemplateStringsArray; values: unknown[] }) => {
        const flat = q.strings.join('?')
        if (/FROM conversations/i.test(flat)) {
            const collected: unknown[] = []
            collectValues(q.values, collected)
            const wantedHashes = new Set(collected.filter((v): v is string => typeof v === 'string'))
            const out: FakeConversationRow[] = []
            for (const c of state.convs) {
                if (c.attachments.some((a) => a.contentHash !== undefined && wantedHashes.has(a.contentHash))) {
                    out.push(c)
                }
            }
            return out
        }
        return []
    })

    return {
        db: { execute },
        sql: sqlTag,
        eq: vi.fn(),
        and: vi.fn(),
        or: vi.fn(),
        ne: vi.fn(),
        desc: vi.fn(),
        asc: vi.fn(),
        inArray: vi.fn(),
        isNull: vi.fn(),
        isNotNull: vi.fn(),
        ilike: vi.fn(),
        lt: vi.fn(),
        lte: vi.fn(),
        gte: vi.fn(),
        count: vi.fn(),
    }
})

vi.mock('@plexo/storage', () => ({
    getByKey: vi.fn(async (key: string) => {
        const found = state.storage.get(key)
        if (!found) throw new Error(`storage miss: ${key}`)
        return found
    }),
}))

vi.mock('../../logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}))

import { resolveOutboundAttachments, type ResolveContext } from '../outbound-attachment-resolver.js'

const PDF_BYTES = Buffer.from('%PDF-1.4 fake content', 'utf8')
const PNG_BYTES = Buffer.from('\x89PNG\r\n\x1a\nIHDRfake', 'binary')

function makeCtx(): ResolveContext & { audits: Array<{ event: string; payload: Record<string, unknown> }> } {
    const audits: Array<{ event: string; payload: Record<string, unknown> }> = []
    return {
        workspaceId: 'ws-1',
        operatorUserId: 'user-1',
        audits,
        auditEmit: async (event, payload) => {
            audits.push({ event, payload })
        },
    } as ResolveContext & { audits: Array<{ event: string; payload: Record<string, unknown> }> }
}

beforeEach(() => {
    state.convs = []
    state.storage.clear()
})

describe('forward-mode', () => {
    it('happy path: clean PDF resolves with bytes from storage', async () => {
        state.convs.push({
            id: 'conv-1',
            workspace_id: 'ws-1',
            attachments: [{
                url: 's3://bucket/key/h1.pdf',
                type: 'application/pdf',
                filename: 'report.pdf',
                sizeBytes: PDF_BYTES.length,
                contentHash: 'h1',
                scanStatus: 'clean',
            }],
        })
        state.storage.set('key/h1.pdf', PDF_BYTES)

        const ctx = makeCtx()
        const result = await resolveOutboundAttachments([{ contentHash: 'h1' }], ctx)
        expect(result.ok).toBe(true)
        expect(result.resolved).toHaveLength(1)
        expect(result.resolved![0]!.bytes.equals(PDF_BYTES)).toBe(true)
        expect(result.resolved![0]!.source).toBe('forward')
        expect(result.resolved![0]!.sourceConversationId).toBe('conv-1')
    })

    it('infected: rejects + audit emits attachment.outbound_blocked reason=infected', async () => {
        state.convs.push({
            id: 'conv-2',
            workspace_id: 'ws-1',
            attachments: [{
                url: 's3://bucket/key/h2.pdf',
                type: 'application/pdf',
                filename: 'malware.pdf',
                sizeBytes: 100,
                contentHash: 'h2',
                scanStatus: 'infected',
            }],
        })
        const ctx = makeCtx()
        const result = await resolveOutboundAttachments([{ contentHash: 'h2' }], ctx)
        expect(result.ok).toBe(false)
        expect(result.error).toBe('infected')
        const a = ctx.audits.find((e) => e.event === 'attachment.outbound_blocked')
        expect(a).toBeTruthy()
        expect(a!.payload.reason).toBe('infected')
    })

    it('unscanned: rejects with pending_approval', async () => {
        state.convs.push({
            id: 'conv-3',
            workspace_id: 'ws-1',
            attachments: [{
                url: 's3://bucket/key/h3.pdf',
                type: 'application/pdf',
                filename: 'pending.pdf',
                sizeBytes: 100,
                contentHash: 'h3',
                scanStatus: 'unscanned',
            }],
        })
        const ctx = makeCtx()
        const result = await resolveOutboundAttachments([{ contentHash: 'h3' }], ctx)
        expect(result.ok).toBe(false)
        expect(result.error).toBe('pending_approval')
        const a = ctx.audits.find((e) => e.event === 'attachment.outbound_blocked')
        expect(a!.payload.reason).toBe('pending_approval')
    })

    it('cross-workspace: rejects', async () => {
        state.convs.push({
            id: 'conv-x',
            workspace_id: 'ws-OTHER',
            attachments: [{
                url: 's3://bucket/key/h4.pdf',
                type: 'application/pdf',
                filename: 'other-ws.pdf',
                sizeBytes: 100,
                contentHash: 'h4',
                scanStatus: 'clean',
            }],
        })
        const ctx = makeCtx()
        const result = await resolveOutboundAttachments([{ contentHash: 'h4' }], ctx)
        expect(result.ok).toBe(false)
        expect(result.error).toBe('cross_workspace')
        expect(ctx.audits.some((e) => e.payload.reason === 'cross_workspace')).toBe(true)
    })

    it('contentHash not found: rejects with not_found', async () => {
        const ctx = makeCtx()
        const result = await resolveOutboundAttachments([{ contentHash: 'h-missing' }], ctx)
        expect(result.ok).toBe(false)
        expect(result.error).toBe('not_found')
    })

    it('batched: two contentHashes resolve in a single conversations query', async () => {
        state.convs.push({
            id: 'conv-A',
            workspace_id: 'ws-1',
            attachments: [{
                url: 's3://bucket/key/hA.pdf',
                type: 'application/pdf',
                filename: 'a.pdf',
                sizeBytes: PDF_BYTES.length,
                contentHash: 'hA',
                scanStatus: 'clean',
            }],
        })
        state.convs.push({
            id: 'conv-B',
            workspace_id: 'ws-1',
            attachments: [{
                url: 's3://bucket/key/hB.png',
                type: 'image/png',
                filename: 'b.png',
                sizeBytes: PNG_BYTES.length,
                contentHash: 'hB',
                scanStatus: 'clean',
            }],
        })
        state.storage.set('key/hA.pdf', PDF_BYTES)
        state.storage.set('key/hB.png', PNG_BYTES)

        const { db } = await import('@plexo/db')
        const execMock = db.execute as unknown as { mock: { calls: unknown[][] } }
        const before = execMock.mock.calls.length

        const ctx = makeCtx()
        const result = await resolveOutboundAttachments(
            [{ contentHash: 'hA' }, { contentHash: 'hB' }],
            ctx,
        )
        expect(result.ok).toBe(true)
        expect(result.resolved).toHaveLength(2)
        expect(result.resolved![0]!.sourceConversationId).toBe('conv-A')
        expect(result.resolved![1]!.sourceConversationId).toBe('conv-B')

        const conversationsCalls = execMock.mock.calls
            .slice(before)
            .filter((args) => {
                const q = args[0] as { strings?: TemplateStringsArray }
                return q?.strings && /FROM conversations/i.test(q.strings.join('?'))
            })
        expect(conversationsCalls).toHaveLength(1)
    })
})

describe('upload-mode', () => {
    it('happy path: base64 PDF passes allow-list + size; source=upload', async () => {
        const ctx = makeCtx()
        const result = await resolveOutboundAttachments(
            [{
                filename: 'report.pdf',
                mimeType: 'application/pdf',
                bytesBase64: PDF_BYTES.toString('base64'),
            }],
            ctx,
        )
        expect(result.ok).toBe(true)
        expect(result.resolved![0]!.source).toBe('upload')
        expect(result.resolved![0]!.bytes.equals(PDF_BYTES)).toBe(true)
    })

    it('.exe extension blocked', async () => {
        const ctx = makeCtx()
        const result = await resolveOutboundAttachments(
            [{
                filename: 'evil.exe',
                mimeType: 'application/octet-stream',
                bytesBase64: Buffer.from('MZ', 'utf8').toString('base64'),
            }],
            ctx,
        )
        expect(result.ok).toBe(false)
        expect(result.error).toBe('extension_blocked')
        expect(ctx.audits.some((e) => e.payload.reason === 'extension_blocked')).toBe(true)
    })

    it('non-allowlisted MIME blocked', async () => {
        const ctx = makeCtx()
        const result = await resolveOutboundAttachments(
            [{
                filename: 'file.bin',
                mimeType: 'application/x-msdownload',
                bytesBase64: Buffer.from('xxx', 'utf8').toString('base64'),
            }],
            ctx,
        )
        expect(result.ok).toBe(false)
        expect(result.error).toBe('mime_blocked')
        expect(ctx.audits.some((e) => e.payload.reason === 'mime_blocked')).toBe(true)
    })

    it('oversized single attachment > 25 MiB rejected', async () => {
        const ctx = makeCtx()
        const huge = Buffer.alloc(26 * 1024 * 1024)
        const result = await resolveOutboundAttachments(
            [{
                filename: 'huge.pdf',
                mimeType: 'application/pdf',
                bytesBase64: huge.toString('base64'),
            }],
            ctx,
        )
        expect(result.ok).toBe(false)
        expect(result.error).toBe('size_exceeded')
    })
})

describe('aggregate caps', () => {
    it('total cap exceeded: 3x10 MiB → total_size_exceeded', async () => {
        const ctx = makeCtx()
        const tenMb = Buffer.alloc(10 * 1024 * 1024)
        const result = await resolveOutboundAttachments(
            [
                { filename: 'a.pdf', mimeType: 'application/pdf', bytesBase64: tenMb.toString('base64') },
                { filename: 'b.pdf', mimeType: 'application/pdf', bytesBase64: tenMb.toString('base64') },
                { filename: 'c.pdf', mimeType: 'application/pdf', bytesBase64: tenMb.toString('base64') },
            ],
            ctx,
        )
        expect(result.ok).toBe(false)
        expect(result.error).toBe('total_size_exceeded')
        expect(ctx.audits.some((e) => e.payload.reason === 'total_size_exceeded')).toBe(true)
    })

    it('count cap: 11 attachments → count_exceeded', async () => {
        const ctx = makeCtx()
        const tiny = Buffer.from('x', 'utf8').toString('base64')
        const inputs = Array.from({ length: 11 }, (_, i) => ({
            filename: `f${i}.pdf`,
            mimeType: 'application/pdf',
            bytesBase64: tiny,
        }))
        const result = await resolveOutboundAttachments(inputs, ctx)
        expect(result.ok).toBe(false)
        expect(result.error).toBe('count_exceeded')
        expect(ctx.audits.some((e) => e.payload.reason === 'count_exceeded')).toBe(true)
    })
})
