// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * @joeybuilt/plexo-sdk runtime channel client (ADR-0002).
 *
 * Sibling apps consume Plexo Channels — list/subscribe/read/send/events — via
 * this client. HMAC-authenticated, host-side REST + SSE. Pex SPEC stays at
 * 0.4.0; the subscription contract is host-side surface area only.
 *
 * Resolves the open question from Levio ADR-03 ("plexo.channel.dispatch()" —
 * unconfirmed there, confirmed and landed here).
 */

import { createHmac } from 'node:crypto'
import type {
    ChannelDescriptor,
    ChannelEvent,
    ChannelMessage,
    ChannelMessagePage,
    ChannelScope,
    ChannelSendRequest,
    ChannelSubscription,
    ChannelThreadPage,
} from './types/channel.js'

export interface ChannelClientOptions {
    /** Plexo Core base URL (e.g. https://plexo.example.com). No trailing slash required. */
    baseUrl: string
    /** PLEXO_SERVICE_KEY shared secret used for HMAC body signatures. */
    serviceKey: string
    /** App identity, mirrored back to Plexo via X-App-Id for scope enforcement. */
    appId: string
    /** Optional fetch override (testing, custom retry). */
    fetchImpl?: typeof fetch
}

export interface ChannelClient {
    list(opts?: { workspaceId?: string }): Promise<ChannelDescriptor[]>
    subscribe(channelId: string, scopes: ChannelScope[]): Promise<ChannelSubscription>
    unsubscribe(channelId: string, subscriptionId: string): Promise<void>
    threads(channelId: string, opts?: { cursor?: string; limit?: number }): Promise<ChannelThreadPage>
    messages(
        channelId: string,
        threadId: string,
        opts?: { cursor?: string; limit?: number },
    ): Promise<ChannelMessagePage>
    send(channelId: string, threadId: string, payload: ChannelSendRequest): Promise<ChannelMessage>
    /**
     * Async iterator over the SSE event stream. The generator reconnects with
     * `Last-Event-ID` on transient drops; callers may abort via the
     * `AbortSignal` parameter.
     */
    events(channelId: string, opts?: { signal?: AbortSignal; lastEventId?: string }): AsyncIterable<ChannelEvent>
}

function sign(secret: string, body: string): string {
    return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
}

function defaultHeaders(opts: ChannelClientOptions, body: string): Record<string, string> {
    return {
        'Content-Type': 'application/json',
        'X-App-Id': opts.appId,
        'X-Plexo-Timestamp': new Date().toISOString(),
        'X-Plexo-Signature': sign(opts.serviceKey, body),
    }
}

async function request<T>(
    opts: ChannelClientOptions,
    method: string,
    path: string,
    body?: unknown,
): Promise<T> {
    const fetchImpl = opts.fetchImpl ?? fetch
    const serialized = body === undefined ? '' : JSON.stringify(body)
    const res = await fetchImpl(`${opts.baseUrl}${path}`, {
        method,
        headers: defaultHeaders(opts, serialized),
        body: body === undefined ? undefined : serialized,
    })
    if (!res.ok) {
        const detail = await res.text().catch(() => '')
        throw new Error(`channel-client: ${method} ${path} failed: ${res.status} ${detail}`)
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
}

export function createChannelClient(opts: ChannelClientOptions): ChannelClient {
    return {
        list: (q) =>
            request<ChannelDescriptor[]>(
                opts,
                'GET',
                `/api/plexo/channels${q?.workspaceId ? `?workspaceId=${encodeURIComponent(q.workspaceId)}` : ''}`,
            ),

        subscribe: (channelId, scopes) =>
            request<ChannelSubscription>(opts, 'POST', `/api/plexo/channels/${channelId}/subscribe`, { scopes }),

        unsubscribe: async (channelId, subscriptionId) => {
            await request<void>(
                opts,
                'DELETE',
                `/api/plexo/channels/${channelId}/subscribe/${subscriptionId}`,
            )
        },

        threads: (channelId, q) => {
            const params = new URLSearchParams()
            if (q?.cursor) params.set('cursor', q.cursor)
            if (q?.limit) params.set('limit', String(q.limit))
            const qs = params.toString()
            return request<ChannelThreadPage>(
                opts,
                'GET',
                `/api/plexo/channels/${channelId}/threads${qs ? `?${qs}` : ''}`,
            )
        },

        messages: (channelId, threadId, q) => {
            const params = new URLSearchParams()
            if (q?.cursor) params.set('cursor', q.cursor)
            if (q?.limit) params.set('limit', String(q.limit))
            const qs = params.toString()
            return request<ChannelMessagePage>(
                opts,
                'GET',
                `/api/plexo/channels/${channelId}/threads/${threadId}/messages${qs ? `?${qs}` : ''}`,
            )
        },

        send: (channelId, threadId, payload) =>
            request<ChannelMessage>(
                opts,
                'POST',
                `/api/plexo/channels/${channelId}/threads/${threadId}/messages`,
                payload,
            ),

        events: (channelId, q) => createEventStream(opts, channelId, q),
    }
}

async function* createEventStream(
    opts: ChannelClientOptions,
    channelId: string,
    q?: { signal?: AbortSignal; lastEventId?: string },
): AsyncGenerator<ChannelEvent, void, unknown> {
    const fetchImpl = opts.fetchImpl ?? fetch
    const url = `${opts.baseUrl}/api/plexo/channels/${channelId}/events`

    const headers: Record<string, string> = {
        Accept: 'text/event-stream',
        'X-App-Id': opts.appId,
        'X-Plexo-Timestamp': new Date().toISOString(),
        'X-Plexo-Signature': sign(opts.serviceKey, ''),
    }
    if (q?.lastEventId) headers['Last-Event-ID'] = q.lastEventId

    const res = await fetchImpl(url, { method: 'GET', headers, signal: q?.signal })
    if (!res.ok || !res.body) {
        throw new Error(`channel-client: SSE ${url} failed: ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // SSE framing: events delimited by blank lines.
        let idx
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, idx)
            buffer = buffer.slice(idx + 2)
            const dataLine = raw.split('\n').find((l) => l.startsWith('data:'))
            if (!dataLine) continue
            const json = dataLine.slice(5).trim()
            if (!json) continue
            try {
                yield JSON.parse(json) as ChannelEvent
            } catch {
                // ignore malformed frames; SSE keepalives may not be valid JSON
            }
        }
    }
}
