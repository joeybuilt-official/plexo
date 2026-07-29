// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * channel.dispatch() server-side handler.
 *
 * Implements the SDK surface added in packages/sdk/src/types/sdk.ts:
 *   sdk.channel.dispatch({ channel, recipientUserId, message, idempotencyKey, scopeOverrides? })
 *
 * Channels:
 *   - 'telegram'   wired to existing bot (apps/api/src/routes/telegram.ts)
 *   - 'email'|'push'|'sms'  return { deliveryStatus: 'not_implemented' } cleanly
 *
 * Idempotency (ADR-15): keyed by tenantId+idempotencyKey, persisted to Redis
 * (24h TTL) when available; falls back to an in-memory Map with TTL when not.
 *
 * Validation errors throw `DispatchValidationError` (HTTP 400 equivalent at the
 * route boundary). Delivery failures resolve with deliveryStatus='failed' so the
 * caller sees structured outcomes instead of catching exceptions.
 */

import pino from 'pino'
import { isRedisAvailable, getRedis } from './redis-client.js'

const logger = pino({ name: 'channel-dispatch' })

export const ALLOWED_CHANNELS = ['telegram', 'email', 'push', 'sms'] as const
export type AllowedChannel = (typeof ALLOWED_CHANNELS)[number]

export interface DispatchParams {
    channel: string
    recipientUserId: string
    message: {
        text: string
        attachments?: unknown[]
        metadata?: Record<string, unknown>
    }
    idempotencyKey: string
    scopeOverrides?: string[]
}

export interface DispatchResult {
    messageId?: string
    deliveryStatus?: string
}

export interface DispatchContext {
    tenantId: string
    workspaceId: string
    userId: string
    traceId: string
    /** Optional injected telegram sender — primarily for tests. */
    telegramSender?: TelegramSender
}

export class DispatchValidationError extends Error {
    code = 'invalid_argument'
    constructor(message: string) {
        super(message)
        this.name = 'DispatchValidationError'
    }
}

// ── Telegram sender ───────────────────────────────────────────────────────────

export interface TelegramSender {
    send(args: { chatId: string; text: string }): Promise<{ messageId?: string; ok: boolean; error?: string }>
}

const TELEGRAM_API = 'https://api.telegram.org/bot'

function defaultTelegramSender(token: string): TelegramSender {
    return {
        async send({ chatId, text }) {
            try {
                const res = await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096) }),
                    signal: AbortSignal.timeout(8_000),
                })
                if (!res.ok) {
                    const body = await res.text().catch(() => '')
                    return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` }
                }
                const data = (await res.json()) as { result?: { message_id?: number } }
                const id = data.result?.message_id
                return { ok: true, messageId: id !== undefined ? String(id) : undefined }
            } catch (err) {
                return { ok: false, error: err instanceof Error ? err.message : String(err) }
            }
        },
    }
}

function resolveTelegramSender(ctx: DispatchContext): TelegramSender | null {
    if (ctx.telegramSender) return ctx.telegramSender
    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) return null
    return defaultTelegramSender(token)
}

// ── Idempotency store ─────────────────────────────────────────────────────────

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 // 1h, ≥1h required
const IDEMPOTENCY_REDIS_TTL_SECONDS = 24 * 60 * 60 // 24h when Redis available

interface MemEntry {
    result: DispatchResult
    expiresAt: number
}

// TODO: when Redis is the established norm (it's already used for queue/PKCE),
// drop the in-memory fallback to avoid divergent behavior across replicas.
const _memStore = new Map<string, MemEntry>()

function memKey(tenantId: string, idempotencyKey: string): string {
    return `${tenantId}::${idempotencyKey}`
}

function redisKey(tenantId: string, idempotencyKey: string): string {
    return `dispatch:idem:${tenantId}:${idempotencyKey}`
}

function pruneMemStore(now: number): void {
    if (_memStore.size < 1024) return
    for (const [k, v] of _memStore) {
        if (v.expiresAt <= now) _memStore.delete(k)
    }
}

async function readIdempotent(tenantId: string, key: string): Promise<DispatchResult | null> {
    const now = Date.now()
    if (isRedisAvailable()) {
        try {
            const r = await getRedis()
            const raw = await r.get(redisKey(tenantId, key))
            if (raw) return JSON.parse(raw) as DispatchResult
        } catch (err) {
            logger.warn({ err }, 'idempotency read fell back to memory')
        }
    }
    const hit = _memStore.get(memKey(tenantId, key))
    if (!hit) return null
    if (hit.expiresAt <= now) {
        _memStore.delete(memKey(tenantId, key))
        return null
    }
    return hit.result
}

async function writeIdempotent(tenantId: string, key: string, result: DispatchResult): Promise<void> {
    const now = Date.now()
    if (isRedisAvailable()) {
        try {
            const r = await getRedis()
            await r.set(redisKey(tenantId, key), JSON.stringify(result), { EX: IDEMPOTENCY_REDIS_TTL_SECONDS })
            return
        } catch (err) {
            logger.warn({ err }, 'idempotency write fell back to memory')
        }
    }
    _memStore.set(memKey(tenantId, key), { result, expiresAt: now + IDEMPOTENCY_TTL_SECONDS * 1000 })
    pruneMemStore(now)
}

// Test-only escape hatch — DO NOT call from production paths.
export function _resetIdempotencyStoreForTests(): void {
    _memStore.clear()
}

// ── Validation ────────────────────────────────────────────────────────────────

function validate(params: DispatchParams): void {
    if (!params.channel || typeof params.channel !== 'string') {
        throw new DispatchValidationError('channel is required')
    }
    if (!ALLOWED_CHANNELS.includes(params.channel as AllowedChannel)) {
        throw new DispatchValidationError(`channel must be one of: ${ALLOWED_CHANNELS.join(', ')}`)
    }
    if (!params.recipientUserId || typeof params.recipientUserId !== 'string') {
        throw new DispatchValidationError('recipientUserId is required')
    }
    if (!params.idempotencyKey || typeof params.idempotencyKey !== 'string') {
        throw new DispatchValidationError('idempotencyKey is required')
    }
    if (!params.message || typeof params.message !== 'object') {
        throw new DispatchValidationError('message is required')
    }
    if (typeof params.message.text !== 'string' || params.message.text.length === 0) {
        throw new DispatchValidationError('message.text must be a non-empty string')
    }
}

// ── Public entry ──────────────────────────────────────────────────────────────

export async function dispatchChannel(
    params: DispatchParams,
    ctx: DispatchContext,
): Promise<DispatchResult> {
    validate(params)

    const cached = await readIdempotent(ctx.tenantId, params.idempotencyKey)
    if (cached) {
        logger.info({
            channel: params.channel,
            tenantId: ctx.tenantId,
            traceId: ctx.traceId,
            idempotencyKey: params.idempotencyKey,
        }, 'channel.dispatch idempotency hit')
        return cached
    }

    let result: DispatchResult
    if (params.channel === 'telegram') {
        const sender = resolveTelegramSender(ctx)
        if (!sender) {
            result = { deliveryStatus: 'not_implemented' }
        } else {
            const out = await sender.send({ chatId: params.recipientUserId, text: params.message.text })
            if (out.ok) {
                result = { deliveryStatus: 'sent', messageId: out.messageId }
            } else {
                result = { deliveryStatus: 'failed' }
                logger.error({
                    channel: 'telegram',
                    tenantId: ctx.tenantId,
                    workspaceId: ctx.workspaceId,
                    traceId: ctx.traceId,
                    error: out.error,
                }, 'channel.dispatch telegram failed')
            }
        }
    } else {
        // email | push | sms — stub. Do NOT throw; callers should branch on status.
        result = { deliveryStatus: 'not_implemented' }
    }

    await writeIdempotent(ctx.tenantId, params.idempotencyKey, result)

    logger.info({
        channel: params.channel,
        tenantId: ctx.tenantId,
        workspaceId: ctx.workspaceId,
        traceId: ctx.traceId,
        deliveryStatus: result.deliveryStatus,
        messageId: result.messageId,
    }, 'channel.dispatch')

    return result
}
