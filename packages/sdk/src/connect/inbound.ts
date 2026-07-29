// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inbound request handling — verifies and dispatches requests Plexo Core
 * sends back to the app (events push + data/tool queries).
 *
 * Framework-agnostic: `handleInbound` receives a plain Request and returns
 * a plain Response so it can be wrapped in any framework's route handler.
 *
 * Next.js:
 *   export const POST = (req: Request) => plexo.inbound.handle(req)
 *
 * Express:
 *   app.post('/api/plexo/events', async (req, res) => {
 *     const raw = JSON.stringify(req.body)
 *     const r = new Request(req.url, { method:'POST', body: raw, headers: req.headers })
 *     const resp = await plexo.inbound.handle(r)
 *     res.status(resp.status).json(await resp.json())
 *   })
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
    DataQuery,
    DataResponse,
    InboundEvent,
    InboundHandlers,
    InboundVerifyResult,
} from './types.js'

const SKEW_MS = 5 * 60 * 1000

export function verifyInboundSignature(
    body: string,
    signature: string | null,
    timestamp: string | null,
    serviceKey: string,
): InboundVerifyResult {
    if (!signature || !timestamp) {
        return { ok: false, error: 'missing X-Plexo-Signature or X-Plexo-Timestamp' }
    }
    const ts = Date.parse(timestamp)
    if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > SKEW_MS) {
        return { ok: false, error: 'timestamp skew exceeds 5 minutes' }
    }
    const expected = 'sha256=' + createHmac('sha256', serviceKey).update(body).digest('hex')
    const sigBuf = Buffer.from(signature)
    const expBuf = Buffer.from(expected)
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        return { ok: false, error: 'signature mismatch' }
    }
    return { ok: true }
}

export function createInboundRouter(serviceKey: string, handlers: InboundHandlers) {
    return {
        async handle(req: Request): Promise<Response> {
            const body = await req.text()
            const sig = req.headers.get('x-plexo-signature')
            const ts = req.headers.get('x-plexo-timestamp')

            const check = verifyInboundSignature(body, sig, ts, serviceKey)
            if (!check.ok) {
                return new Response(
                    JSON.stringify({ error: check.error }),
                    { status: 401, headers: { 'Content-Type': 'application/json' } },
                )
            }

            let parsed: unknown
            try {
                parsed = JSON.parse(body)
            } catch {
                return new Response(
                    JSON.stringify({ error: 'invalid JSON' }),
                    { status: 400, headers: { 'Content-Type': 'application/json' } },
                )
            }

            const msg = parsed as Record<string, unknown>
            const kind = msg['kind'] as string | undefined

            try {
                if (kind === 'event' && handlers.onEvent) {
                    await handlers.onEvent(msg['event'] as InboundEvent)
                    return new Response(null, { status: 204 })
                }

                if (kind === 'data_query' && handlers.onDataQuery) {
                    const query = msg['query'] as DataQuery
                    const result = await handlers.onDataQuery(query)
                    const response: DataResponse = { requestId: query.requestId, result }
                    return new Response(
                        JSON.stringify(response),
                        { status: 200, headers: { 'Content-Type': 'application/json' } },
                    )
                }

                return new Response(null, { status: 204 })
            } catch (err) {
                const response: DataResponse = {
                    requestId: (msg['query'] as DataQuery | undefined)?.requestId ?? '',
                    error: err instanceof Error ? err.message : String(err),
                }
                return new Response(
                    JSON.stringify(response),
                    { status: 500, headers: { 'Content-Type': 'application/json' } },
                )
            }
        },
    }
}
