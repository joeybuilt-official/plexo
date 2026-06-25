// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0012 — attachment scan worker tests.
 *
 * NOTE on harness choice: pg-mem doesn't reliably support the `jsonb_set` /
 * `jsonb_array_elements WITH ORDINALITY` / `@>` containment combo used in
 * `fanOutToConversations`. Rather than fight that, we mock `@plexo/db`'s
 * `db.execute` against the SQL templates, route by inspecting the strings,
 * and maintain an in-memory representation of `attachment_scan_queue` rows
 * + `conversations.attachments` JSONB arrays. This lets us assert the exact
 * state transitions the worker is supposed to drive.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// In-memory fake DB state — populated per-test via `state.queue` / `state.convs`.
// ---------------------------------------------------------------------------

type QueueRow = {
    id: string
    workspace_id: string
    conversation_id: string
    content_hash: string
    storage_url: string
    mime_type: string
    size_bytes: number
    enqueued_at: Date
    next_attempt_at: Date
    started_at: Date | null
    completed_at: Date | null
    consecutive_failures: number
    last_error: string | null
    result: string | null
}

type ConvRow = {
    id: string
    workspace_id: string
    attachments: Array<Record<string, unknown>>
}

const state = {
    queue: [] as QueueRow[],
    convs: [] as ConvRow[],
    audits: [] as Array<{ action: string; metadata: Record<string, unknown>; resourceId?: string }>,
}

function joinSqlTemplate(parts: { strings: TemplateStringsArray; values: unknown[] }): {
    flat: string
    values: unknown[]
} {
    const { strings, values } = parts
    let flat = ''
    for (let i = 0; i < strings.length; i++) {
        flat += strings[i]
        if (i < values.length) {
            const v = values[i]
            if (v && typeof v === 'object' && 'raw' in (v as object)) {
                flat += String((v as { raw: unknown }).raw)
            } else {
                flat += `$${i + 1}`
            }
        }
    }
    return { flat, values }
}

vi.mock('@plexo/db', () => {
    const sqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values })
    sqlTag.raw = (s: string) => ({ raw: s })

    const execute = vi.fn(async (q: { strings: TemplateStringsArray; values: unknown[] }) => {
        const { flat, values } = joinSqlTemplate(q)
        const norm = flat.replace(/\s+/g, ' ').trim()

        // queue depth
        if (/SELECT count\(\*\)::int AS depth FROM attachment_scan_queue/i.test(norm)) {
            const depth = state.queue.filter((r) => !r.completed_at).length
            return [{ depth }]
        }

        // claim
        if (/UPDATE attachment_scan_queue q SET started_at = now\(\) FROM picked/i.test(norm)) {
            const now = Date.now()
            const stuckCutoff = now - 5 * 60_000
            const candidates = state.queue
                .filter((r) =>
                    !r.completed_at
                    && (!r.started_at || r.started_at.getTime() < stuckCutoff)
                    && r.next_attempt_at.getTime() <= now,
                )
                .sort((a, b) => a.enqueued_at.getTime() - b.enqueued_at.getTime())
                .slice(0, 4)
            const claimed = candidates.map((r) => {
                r.started_at = new Date()
                return {
                    id: r.id,
                    workspace_id: r.workspace_id,
                    conversation_id: r.conversation_id,
                    content_hash: r.content_hash,
                    storage_url: r.storage_url,
                    mime_type: r.mime_type,
                    size_bytes: r.size_bytes,
                    consecutive_failures: r.consecutive_failures,
                }
            })
            return claimed
        }

        // recordSuccess: SET completed_at = now(), result = $1, consecutive_failures = 0, last_error = $2 WHERE id = $3
        if (/SET completed_at = now\(\), result = \$1, consecutive_failures = 0, last_error = \$2 WHERE id = \$3/i.test(norm)) {
            const [resultStatus, lastErr, rowId] = values as [string, string | null, string]
            const r = state.queue.find((q2) => q2.id === rowId)
            if (r) {
                r.completed_at = new Date()
                r.result = resultStatus
                r.consecutive_failures = 0
                r.last_error = lastErr
            }
            return []
        }

        // recordPermanentError: SET completed_at = now(), result = 'error', consecutive_failures = $1, last_error = $2 WHERE id = $3
        if (/SET completed_at = now\(\), result = 'error', consecutive_failures = \$1, last_error = \$2 WHERE id = \$3/i.test(norm)) {
            const [failures, lastErr, rowId] = values as [number, string, string]
            const r = state.queue.find((q2) => q2.id === rowId)
            if (r) {
                r.completed_at = new Date()
                r.result = 'error'
                r.consecutive_failures = failures
                r.last_error = lastErr
            }
            return []
        }

        // recordTransientFailure: SET started_at = NULL, consecutive_failures = $1, last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $4
        if (/SET started_at = NULL, consecutive_failures = \$1, last_error = \$2/i.test(norm)) {
            const [failures, lastErr, delaySecs, rowId] = values as [number, string, number, string]
            const r = state.queue.find((q2) => q2.id === rowId)
            if (r) {
                r.started_at = null
                r.consecutive_failures = failures
                r.last_error = lastErr
                r.next_attempt_at = new Date(Date.now() + Number(delaySecs) * 1000)
            }
            return []
        }

        // fanOutToConversations after HIGH-1 fix:
        //   $1=workspaceId (outer SELECT), $2=contentHash (inner @>), $3=contentHash (e.elem ->>),
        //   $4=scanStatus, $5=signature (CASE WHEN), $6=signature (jsonb_build_object), $7=workspaceId (UPDATE WHERE).
        if (/WITH targets AS \(\s*SELECT c\.id, \(idx - 1\) AS arr_index/i.test(norm)) {
            const [workspaceId, contentHash1, _contentHash2, scanStatus, sigParam1, sigParam2] = values as [
                string, string, string, string, string | null, string | null,
            ]
            const ch = contentHash1
            const sig = sigParam1 ?? sigParam2
            for (const c of state.convs) {
                if (c.workspace_id !== workspaceId) continue
                for (let i = 0; i < c.attachments.length; i++) {
                    const att = c.attachments[i]!
                    if (att.contentHash === ch) {
                        att.scanStatus = scanStatus
                        if (sig != null) att.signature = sig
                    }
                }
            }
            return []
        }

        return []
    })

    return {
        db: { execute },
        sql: sqlTag,
    }
})

// ADR-0045 Phase 2: source imports drizzle operators from 'drizzle-orm' now.
// Mirror whatever operator stubs the @plexo/db mock defines so the fake db
// still sees the same recognizable shapes (fall back to real drizzle otherwise).
vi.mock('drizzle-orm', async (importOriginal) => {
    const real = await importOriginal<Record<string, unknown>>()
    const m = (await import('@plexo/db')) as Record<string, unknown>
    const pick = (k: string): unknown => (k in m ? m[k] : real[k])
    return {
        ...real,
        eq: pick('eq'), and: pick('and'), or: pick('or'), ne: pick('ne'),
        desc: pick('desc'), asc: pick('asc'), inArray: pick('inArray'),
        isNull: pick('isNull'), isNotNull: pick('isNotNull'), ilike: pick('ilike'),
        lt: pick('lt'), lte: pick('lte'), gte: pick('gte'), count: pick('count'),
        sql: pick('sql'),
    }
})


vi.mock('@plexo/storage', () => ({
    getByKey: vi.fn(async () => Buffer.from('default')),
}))

vi.mock('../../audit.js', () => ({
    audit: vi.fn((_req: unknown, entry: { action: string; metadata: Record<string, unknown>; resourceId?: string }) => {
        state.audits.push({ action: entry.action, metadata: entry.metadata, resourceId: entry.resourceId })
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

import { runAttachmentScanTick } from '../attachment-scan-worker.js'
import { incrementCounter, getCounterSeries, counter } from '../metrics.js'

// Register the metric so getCounterSeries returns the labeled series.
counter('plexo_clamd_scan_total', 'test')

function makeQueueRow(over: Partial<QueueRow> = {}): QueueRow {
    return {
        id: over.id ?? `row-${Math.random().toString(36).slice(2, 8)}`,
        workspace_id: over.workspace_id ?? 'ws-1',
        conversation_id: over.conversation_id ?? 'conv-1',
        content_hash: over.content_hash ?? 'h0000000',
        storage_url: over.storage_url ?? 's3://bkt/key',
        mime_type: over.mime_type ?? 'application/pdf',
        size_bytes: over.size_bytes ?? 100,
        enqueued_at: over.enqueued_at ?? new Date(Date.now() - 1000),
        next_attempt_at: over.next_attempt_at ?? new Date(Date.now() - 1000),
        started_at: over.started_at ?? null,
        completed_at: over.completed_at ?? null,
        consecutive_failures: over.consecutive_failures ?? 0,
        last_error: over.last_error ?? null,
        result: over.result ?? null,
    }
}

function clean(): import('../clamd-client.js').ClamdScanResult {
    return { status: 'clean', durationMs: 5 }
}

function infected(sig: string): import('../clamd-client.js').ClamdScanResult {
    return { status: 'infected', signature: sig, durationMs: 5 }
}

beforeEach(() => {
    state.queue = []
    state.convs = []
    state.audits = []
})

function counterValue(result: string): number {
    const series = getCounterSeries('plexo_clamd_scan_total')
    const match = series.find((s) => s.labels?.result === result)
    return match?.value ?? 0
}

describe('runAttachmentScanTick — happy path', () => {
    it('clean scan: row→completed, conv attachment→clean, audit emitted, metric bumped', async () => {
        const before = counterValue('clean')
        state.queue.push(makeQueueRow({ id: 'r1', content_hash: 'aaaa', storage_url: 's3://b/aaaa' }))
        state.convs.push({ id: 'conv-1', workspace_id: 'ws-1', attachments: [{ contentHash: 'aaaa', scanStatus: 'unscanned', filename: 'x.pdf' }],
        })

        const tick = await runAttachmentScanTick({
            fetcher: async () => Buffer.from('clean-bytes'),
            scanner: async () => clean(),
        })

        expect(tick.claimed).toBe(1)
        expect(tick.processed).toBe(1)
        expect(tick.errored).toBe(0)
        const r = state.queue[0]!
        expect(r.completed_at).toBeInstanceOf(Date)
        expect(r.result).toBe('clean')
        expect(r.consecutive_failures).toBe(0)
        expect(state.convs[0]!.attachments[0]!.scanStatus).toBe('clean')
        expect(state.audits.some((a) => a.action === 'attachment.scanned' && a.metadata.status === 'clean')).toBe(true)
        expect(counterValue('clean')).toBeGreaterThan(before)
    })
})

describe('runAttachmentScanTick — infected', () => {
    it('infected scan: conv attachment.scanStatus=infected, signature populated', async () => {
        state.queue.push(makeQueueRow({ id: 'r-eic', content_hash: 'eic1' }))
        state.convs.push({ id: 'conv-1', workspace_id: 'ws-1', attachments: [{ contentHash: 'eic1', scanStatus: 'unscanned' }],
        })

        await runAttachmentScanTick({
            fetcher: async () => Buffer.from('eicar'),
            scanner: async () => infected('Eicar-Test-Signature'),
        })

        const att = state.convs[0]!.attachments[0]!
        expect(att.scanStatus).toBe('infected')
        expect(att.signature).toBe('Eicar-Test-Signature')
        const r = state.queue[0]!
        expect(r.result).toBe('infected')
    })
})

describe('runAttachmentScanTick — recovery of stuck row', () => {
    it('row with started_at = 6 min ago, completed_at NULL, consecutive_failures=0 → re-claimed; failures NOT incremented', async () => {
        const sixMinAgo = new Date(Date.now() - 6 * 60_000)
        state.queue.push(makeQueueRow({
            id: 'stuck',
            content_hash: 'stk',
            started_at: sixMinAgo,
            completed_at: null,
            consecutive_failures: 0,
        }))
        state.convs.push({ id: 'c', workspace_id: 'ws-1', attachments: [{ contentHash: 'stk', scanStatus: 'unscanned' }] })

        const tick = await runAttachmentScanTick({
            fetcher: async () => Buffer.from('x'),
            scanner: async () => clean(),
        })

        expect(tick.claimed).toBe(1)
        const r = state.queue[0]!
        expect(r.consecutive_failures).toBe(0) // pre-mortem #2 — worker fault, not clamd
        expect(r.result).toBe('clean')
    })
})

describe('runAttachmentScanTick — clamd unreachable (transient)', () => {
    it('ECONNREFUSED → consecutive_failures 0→1, last_error populated, started_at=NULL, NOT completed', async () => {
        state.queue.push(makeQueueRow({ id: 'cre', content_hash: 'cre1', consecutive_failures: 0 }))
        state.convs.push({ id: 'c', workspace_id: 'ws-1', attachments: [{ contentHash: 'cre1', scanStatus: 'unscanned' }] })

        await runAttachmentScanTick({
            fetcher: async () => Buffer.from('x'),
            scanner: async () => { throw new Error('ECONNREFUSED clamd:3310') },
        })

        const r = state.queue[0]!
        expect(r.consecutive_failures).toBe(1)
        expect(r.last_error).toMatch(/ECONNREFUSED/)
        expect(r.started_at).toBeNull()
        expect(r.completed_at).toBeNull()
        // conv NOT yet flipped to error — we still hope to scan it later
        expect(state.convs[0]!.attachments[0]!.scanStatus).toBe('unscanned')
    })
})

describe('runAttachmentScanTick — permanent error after 5 failures', () => {
    it('consecutive_failures already 4 → bumps to 5, marks result=error, completed_at=now, fans out scanStatus=error', async () => {
        state.queue.push(makeQueueRow({ id: 'perm', content_hash: 'perm1', consecutive_failures: 4 }))
        state.convs.push({ id: 'c', workspace_id: 'ws-1', attachments: [{ contentHash: 'perm1', scanStatus: 'unscanned' }] })

        await runAttachmentScanTick({
            fetcher: async () => Buffer.from('x'),
            scanner: async () => { throw new Error('ECONNREFUSED still down') },
        })

        const r = state.queue[0]!
        expect(r.consecutive_failures).toBe(5)
        expect(r.result).toBe('error')
        expect(r.completed_at).toBeInstanceOf(Date)
        expect(state.convs[0]!.attachments[0]!.scanStatus).toBe('error')
    })
})

describe('runAttachmentScanTick — fan-out across multiple conversations', () => {
    it('same contentHash in two different conversations → both rows updated', async () => {
        state.queue.push(makeQueueRow({ id: 'multi', content_hash: 'shared', conversation_id: 'conv-A' }))
        state.convs.push({ id: 'conv-A', workspace_id: 'ws-1', attachments: [{ contentHash: 'shared', scanStatus: 'unscanned', filename: 'a.pdf' }],
        })
        state.convs.push({ id: 'conv-B', workspace_id: 'ws-1', attachments: [
                { contentHash: 'other', scanStatus: 'unscanned' },
                { contentHash: 'shared', scanStatus: 'unscanned', filename: 'b.pdf' },
            ],
        })

        await runAttachmentScanTick({
            fetcher: async () => Buffer.from('x'),
            scanner: async () => clean(),
        })

        expect(state.convs[0]!.attachments[0]!.scanStatus).toBe('clean')
        expect(state.convs[1]!.attachments[0]!.scanStatus).toBe('unscanned') // unrelated
        expect(state.convs[1]!.attachments[1]!.scanStatus).toBe('clean')
    })
})

describe('runAttachmentScanTick — idempotent fan-out', () => {
    it('running fan-out twice is a no-op', async () => {
        state.queue.push(makeQueueRow({ id: 'idem1', content_hash: 'h-idem' }))
        state.convs.push({ id: 'c', workspace_id: 'ws-1', attachments: [{ contentHash: 'h-idem', scanStatus: 'unscanned' }],
        })

        await runAttachmentScanTick({
            fetcher: async () => Buffer.from('x'),
            scanner: async () => clean(),
        })
        const after1 = JSON.stringify(state.convs)

        // Re-enqueue + run again with same content hash; expect identical end state.
        state.queue.push(makeQueueRow({
            id: 'idem2',
            content_hash: 'h-idem',
            enqueued_at: new Date(Date.now() - 500),
        }))
        await runAttachmentScanTick({
            fetcher: async () => Buffer.from('x'),
            scanner: async () => clean(),
        })

        expect(JSON.stringify(state.convs)).toBe(after1)
    })
})
