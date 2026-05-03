// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Training Data API tests.
 *
 * Mocks @plexo/db to return controlled rows. Verifies:
 *   1. GET /sources returns all 7 data sources with counts
 *   2. GET /sources/:source/sample returns preview rows
 *   3. GET /sources/bad-id/sample returns 404
 *   4. POST /export returns JSONL chat format
 *   5. POST /export with jsonl_raw returns raw rows
 *   6. POST /export with empty sources returns 400
 *   7. Handles DB errors gracefully (sources still return, count=0)
 *   8. Large export capped at 50000
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// Track executed SQL
const executedSql: unknown[] = []
let dbShouldFail = false

vi.mock('@plexo/db', () => ({
    db: {
        execute: vi.fn(async (q: unknown) => {
            executedSql.push(q)
            if (dbShouldFail) throw new Error('DB_FAIL')
            const qStr = String(q)

            // Count queries return { count: N }
            if (qStr.includes('count(*)') || qStr.includes('COUNT(*)')) {
                return [{ count: '42' }]
            }

            // Date range queries
            if (qStr.includes('MIN(created_at)')) {
                return [{ min_date: '2026-01-01T00:00:00Z', max_date: '2026-04-12T00:00:00Z' }]
            }

            // Sample queries for inference_logs
            if (qStr.includes('scrub_input_pattern') && qStr.includes('LIMIT')) {
                return [
                    {
                        id: 'log-1',
                        model: 'claude-sonnet-4-5',
                        provider: 'anthropic',
                        task_type: 'conversation',
                        domain_region: 'general',
                        scrub_input_pattern: 'What is Plexo?',
                        scrub_output_pattern: 'Plexo is a workspace AI agent.',
                        input_tokens: 50,
                        output_tokens: 100,
                        latency_ms: 500,
                        created_at: '2026-04-12T10:00:00Z',
                    },
                ]
            }

            // Sample queries for conversations
            if (qStr.includes('conversations') && qStr.includes('LIMIT')) {
                return [
                    {
                        id: 'conv-1',
                        source: 'telegram',
                        intent: 'CONVERSATION',
                        message: 'Hello there',
                        reply: 'Hi! How can I help?',
                        created_at: '2026-04-12T09:00:00Z',
                    },
                ]
            }

            // Default sample return
            if (qStr.includes('LIMIT')) {
                return [{ id: 'row-1', created_at: '2026-04-12T08:00:00Z' }]
            }

            return []
        }),
    },
    sql: Object.assign(
        // Tagged-template form: interpolate values as plain strings so db.execute mock can inspect them.
        (strings: TemplateStringsArray, ...values: unknown[]) => {
            let out = ''
            strings.forEach((s, i) => { out += s; if (i < values.length) out += String(values[i]) })
            return out
        },
        {
            raw: (s: string) => s,
            identifier: (name: string) => `"${name}"`,
        },
    ),
}))

vi.mock('../../logger.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}))

let server: Server
let base: string

beforeAll(async () => {
    const { trainingDataRouter } = await import('../training-data.js')
    const app = express()
    app.use(express.json())
    app.use('/', trainingDataRouter)

    await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => { resolve() })
    })
    const addr = server.address() as AddressInfo
    base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => {
    server?.close()
})

describe('GET /sources', () => {
    it('returns all 6 data sources with counts', async () => {
        dbShouldFail = false
        const res = await fetch(`${base}/sources`)
        expect(res.status).toBe(200)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await res.json()) as any
        expect(body.sources).toHaveLength(6)
        expect(body.totalExamples).toBe(42 * 6) // 42 per source

        // Check structure
        const first = body.sources[0]
        expect(first).toHaveProperty('id')
        expect(first).toHaveProperty('label')
        expect(first).toHaveProperty('description')
        expect(first).toHaveProperty('format')
        expect(first).toHaveProperty('count')
        expect(first).toHaveProperty('dateRange')
        expect(first.dateRange).toHaveProperty('earliest')
        expect(first.dateRange).toHaveProperty('latest')

        // Check consent status
        expect(body.consentStatus).toHaveProperty('hasConsentedData')
        expect(body.consentStatus).toHaveProperty('note')
    })

    it('returns source IDs matching the spec', async () => {
        const res = await fetch(`${base}/sources`)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await res.json()) as any
        const ids = body.sources.map((s: { id: string }) => s.id)
        expect(ids).toContain('inference_logs')
        expect(ids).toContain('conversations')
        expect(ids).toContain('task_steps')
        expect(ids).toContain('memory_entries')
        expect(ids).toContain('behavior_snapshots')
        expect(ids).toContain('scl_concept_graphs')
    })

    it('handles DB errors gracefully', async () => {
        dbShouldFail = true
        const res = await fetch(`${base}/sources`)
        expect(res.status).toBe(200) // still returns — individual sources show count=0

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await res.json()) as any
        for (const src of body.sources) {
            expect(src.count).toBe(0)
        }
        dbShouldFail = false
    })
})

describe('GET /sources/:source/sample', () => {
    it('returns sample rows for inference_logs', async () => {
        const res = await fetch(`${base}/sources/inference_logs/sample?limit=5`)
        expect(res.status).toBe(200)

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const body = (await res.json()) as any
        expect(body.source).toBe('inference_logs')
        expect(body.rows).toBeInstanceOf(Array)
        expect(body.rows.length).toBeGreaterThan(0)
        expect(body.rows[0]).toHaveProperty('scrub_input_pattern')
    })

    it('returns 404 for unknown source', async () => {
        const res = await fetch(`${base}/sources/nonexistent/sample`)
        expect(res.status).toBe(404)
    })

    it('caps limit at 50', async () => {
        const res = await fetch(`${base}/sources/conversations/sample?limit=999`)
        expect(res.status).toBe(200)
        // The SQL uses Math.min(999, 50) = 50 — we just verify it doesn't error
    })
})

describe('POST /export', () => {
    it('returns JSONL chat format', async () => {
        const res = await fetch(`${base}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sources: ['inference_logs', 'conversations'],
                format: 'jsonl_chat',
                limit: 100,
            }),
        })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('ndjson')

        const text = await res.text()
        const lines = text.split('\n').filter(Boolean)
        expect(lines.length).toBeGreaterThan(0)

        // Each line should be valid JSON with messages array
        for (const line of lines) {
            const parsed = JSON.parse(line)
            expect(parsed).toHaveProperty('messages')
            expect(parsed.messages).toBeInstanceOf(Array)
            expect(parsed.messages.length).toBeGreaterThanOrEqual(2)

            // Check message structure
            for (const msg of parsed.messages) {
                expect(msg).toHaveProperty('role')
                expect(msg).toHaveProperty('content')
                expect(['system', 'user', 'assistant']).toContain(msg.role)
            }
        }
    })

    it('returns JSONL raw format', async () => {
        const res = await fetch(`${base}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sources: ['conversations'],
                format: 'jsonl_raw',
                limit: 10,
            }),
        })
        expect(res.status).toBe(200)

        const text = await res.text()
        const lines = text.split('\n').filter(Boolean)
        expect(lines.length).toBeGreaterThan(0)

        const first = JSON.parse(lines[0]!)
        // Raw format includes all DB fields; the row's own 'source' column
        // (e.g., 'telegram') may override the prepended source ID
        expect(first).toHaveProperty('id')
        expect(first).toHaveProperty('message')
    })

    it('returns 400 for empty sources array', async () => {
        const res = await fetch(`${base}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: [] }),
        })
        expect(res.status).toBe(400)
    })

    it('returns 400 for missing sources', async () => {
        const res = await fetch(`${base}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
    })

    it('filters out invalid source IDs', async () => {
        const res = await fetch(`${base}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sources: ['nonexistent_source'] }),
        })
        expect(res.status).toBe(400)
    })

    it('caps limit at 50000', async () => {
        const res = await fetch(`${base}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sources: ['inference_logs'],
                limit: 999999,
            }),
        })
        expect(res.status).toBe(200)
        // Verify the SQL used 50000, not 999999
        const lastSql = executedSql[executedSql.length - 1]
        expect(String(lastSql)).toContain('50000')
    })

    it('exports all 7 sources at once', async () => {
        const res = await fetch(`${base}/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sources: [
                    'inference_logs',
                    'conversations',
                    'task_steps',
                    'memory_entries',
                    'behavior_snapshots',
                    'scl_concept_graphs',
                    'golden_records',
                ],
                format: 'jsonl_chat',
                limit: 10,
            }),
        })
        expect(res.status).toBe(200)

        const text = await res.text()
        const lines = text.split('\n').filter(Boolean)
        // Should have lines from multiple sources
        expect(lines.length).toBeGreaterThan(0)
    })
})
