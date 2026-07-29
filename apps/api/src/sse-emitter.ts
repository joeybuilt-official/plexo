// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { Response } from 'express'
import { randomUUID } from 'crypto'
import pino from 'pino'
import { getRedis, isRedisAvailable, markRedisDown } from './redis-client.js'

const logger = pino({ name: 'sse-emitter' })

/** Connected SSE clients — keyed by workspace ID, then a unique connection ID */
const clients = new Map<string, Map<string, Response>>()
let connId = 0

// ── B3: SSE Redis fan-out for multi-replica ─────────────────────────────
/** Unique id for THIS process/replica — lets the subscriber skip its own publishes */
const INSTANCE_ID = randomUUID()
/** Redis pub/sub channel prefix; one channel per workspace */
const SSE_CHANNEL_PREFIX = 'plexo:sse:'

interface SseEnvelope {
    instanceId: string
    workspaceId: string
    event: AgentEvent
}

// ── Connection caps ─────────────────────────────────────────
const MAX_CONNECTIONS_PER_USER_PER_WORKSPACE = 5
const MAX_CONNECTIONS_PER_WORKSPACE = 50

/** Track connection count per user per workspace: "wsId:userId" → count */
const userConnCounts = new Map<string, number>()
/** Track which user owns each connection: "wsId:connId" → userConnKey */
const connOwners = new Map<string, string>()

/**
 * Register an SSE client. Returns the connection ID on success, or null
 * if the connection was rejected due to cap limits (response is ended).
 */
export function registerClient(workspaceId: string, res: Response, userId?: string): string | null {
    // Per-workspace cap
    const wsClients = clients.get(workspaceId)
    if (wsClients && wsClients.size >= MAX_CONNECTIONS_PER_WORKSPACE) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Workspace connection limit reached' })}\n\n`)
        res.end()
        return null
    }

    // Per-user-per-workspace cap
    const userKey = userId ? `${workspaceId}:${userId}` : null
    if (userKey) {
        const current = userConnCounts.get(userKey) ?? 0
        if (current >= MAX_CONNECTIONS_PER_USER_PER_WORKSPACE) {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Per-user connection limit reached' })}\n\n`)
            res.end()
            return null
        }
        userConnCounts.set(userKey, current + 1)
    }

    // B3: lazily bring up the cross-replica subscriber on first register.
    void initCrossReplicaSubscriber()

    const id = String(++connId)
    if (!clients.has(workspaceId)) {
        clients.set(workspaceId, new Map())
    }
    clients.get(workspaceId)!.set(id, res)

    // Track ownership for cleanup
    if (userKey) {
        connOwners.set(`${workspaceId}:${id}`, userKey)
    }

    return id
}

export function unregisterClient(workspaceId: string, id: string): void {
    clients.get(workspaceId)?.delete(id)

    // Decrement user connection counter
    const ownerKey = `${workspaceId}:${id}`
    const userKey = connOwners.get(ownerKey)
    if (userKey) {
        const count = (userConnCounts.get(userKey) ?? 1) - 1
        if (count <= 0) {
            userConnCounts.delete(userKey)
        } else {
            userConnCounts.set(userKey, count)
        }
        connOwners.delete(ownerKey)
    }
}

export interface AgentEvent {
    type: string
    [key: string]: unknown
}

/**
 * Deliver an event to all LOCAL connected clients for a workspace.
 * Single delivery implementation shared by the direct emit path and the
 * cross-replica Redis subscriber. Returns true if at least one local client
 * received the frame. Behavior is byte-for-byte identical to the prior
 * inline loop in emitToWorkspace.
 */
function deliverLocal(workspaceId: string, event: AgentEvent): boolean {
    const workspace = clients.get(workspaceId)
    let delivered = false
    if (workspace) {
        const data = `data: ${JSON.stringify(event)}\n\n`
        for (const [id, res] of workspace) {
            try {
                res.write(data)
                delivered = true
            } catch {
                // intentional — socket gone; unregisterClient so userConnCounts is decremented properly
                unregisterClient(workspaceId, id)
            }
        }
    }
    return delivered
}

/** Emit an event to all connected clients for a workspace */
export function emitToWorkspace(workspaceId: string, event: AgentEvent): void {
    // Local synchronous delivery — unchanged hot path
    const delivered = deliverLocal(workspaceId, event)

    // Write delivery ack for OWD events when at least one SSE client received it
    if (delivered && event.taskId && (event.type === 'owd_pending' || (event as Record<string, unknown>).operation)) {
        writeDeliveryAck(String(event.taskId)).catch(() => {})
    }

    // Always notify internal subscribers (Telegram, Slack adapters) regardless
    // of whether any SSE clients are connected.
    notifyInternal(event)

    // B3: additive cross-replica fan-out. Fire-and-forget; never throws into
    // the caller. The local subscriber will receive this publish and SKIP it
    // (instanceId match), so there is no double-delivery at one replica.
    publishCrossReplica(workspaceId, event)
}

/** B3: publish the emitted event to Redis so other replicas can deliver it to their local clients */
function publishCrossReplica(workspaceId: string, event: AgentEvent): void {
    if (!isRedisAvailable()) return // Redis-down → local-only, no publish
    const envelope: SseEnvelope = { instanceId: INSTANCE_ID, workspaceId, event }
    void (async () => {
        try {
            const redis = await getRedis()
            await redis.publish(`${SSE_CHANNEL_PREFIX}${workspaceId}`, JSON.stringify(envelope))
        } catch (err) {
            markRedisDown()
            logger.warn({ err, workspaceId }, 'B3: cross-replica SSE publish failed — local delivery unaffected')
        }
    })()
}

/** Write OWD delivery acknowledgment to Redis so the one-way-door service knows SSE delivery succeeded */
async function writeDeliveryAck(taskId: string): Promise<void> {
    // OPS-003: Skip ack write when Redis circuit is open — OWD will retry
    if (!isRedisAvailable()) return
    try {
        const redis = await getRedis()
        await redis.set(`owd:${taskId}:ack`, '1', { EX: 300 })
    } catch {
        markRedisDown()
    }
}

/** Emit an event to all connected clients across all workspaces */
export function emit(event: AgentEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const [wsId, workspace] of clients) {
        for (const [id, res] of workspace) {
            try {
                res.write(data)
            } catch {
                // Use unregisterClient so userConnCounts is decremented properly
                unregisterClient(wsId, id)
            }
        }
    }
    notifyInternal(event)
}

export function connectedCount(): number {
    // B3 follow-up: cross-replica count needs a Redis aggregate
    let total = 0
    for (const workspace of clients.values()) total += workspace.size
    return total
}

// ── B3: cross-replica subscriber ────────────────────────────────────────
/** Dedicated Redis subscriber connection (node-redis requires a separate conn for (p)subscribe) */
let subscriber: Awaited<ReturnType<typeof getRedis>> | null = null
/** Guard so init runs at most once concurrently / once successfully */
let subscriberInitializing = false

/**
 * Lazily create ONE dedicated Redis subscriber and PSUBSCRIBE plexo:sse:*.
 * Idempotent: skips if already subscribed or currently initializing. If Redis
 * is unavailable, skips quietly — a later registerClient retries. On any error
 * it logs and leaves local-only delivery intact (never crashes).
 */
async function initCrossReplicaSubscriber(): Promise<void> {
    if (subscriber || subscriberInitializing) return
    if (!isRedisAvailable()) return // retry on a later register
    subscriberInitializing = true
    try {
        const sub = (await getRedis()).duplicate()
        sub.on('error', (err: Error) => {
            logger.warn({ err }, 'B3: SSE Redis subscriber error — local delivery unaffected')
        })
        await sub.connect()
        await sub.pSubscribe(`${SSE_CHANNEL_PREFIX}*`, (message: string) => {
            try {
                const envelope = JSON.parse(message) as SseEnvelope
                // Skip our own publishes — already delivered locally in emitToWorkspace
                if (envelope.instanceId === INSTANCE_ID) return
                if (!envelope.workspaceId) return
                deliverLocal(envelope.workspaceId, envelope.event)
            } catch (err) {
                logger.warn({ err }, 'B3: failed to handle cross-replica SSE message')
            }
        })
        subscriber = sub
        logger.info({ instanceId: INSTANCE_ID }, 'B3: cross-replica SSE subscriber active')
    } catch (err) {
        markRedisDown()
        logger.warn({ err }, 'B3: cross-replica SSE subscriber init failed — local-only fan-out')
    } finally {
        subscriberInitializing = false
    }
}

// ── Internal event bus (for non-SSE subscribers like Telegram adapter) ────────

type InternalHandler = (event: AgentEvent) => void
const internalHandlers: InternalHandler[] = []

/** Register a handler that receives every emitted event (all workspaces) */
export function onAgentEvent(handler: InternalHandler): () => void {
    internalHandlers.push(handler)
    return () => {
        const i = internalHandlers.indexOf(handler)
        if (i !== -1) internalHandlers.splice(i, 1)
    }
}

// Sweep empty workspace keys every 5 minutes to prevent unbounded Map growth
setInterval(() => {
    for (const [wsId, ws] of clients) {
        if (ws.size === 0) clients.delete(wsId)
    }
    // Sweep stale user connection counters
    for (const [key, count] of userConnCounts) {
        if (count <= 0) userConnCounts.delete(key)
    }
}, 5 * 60 * 1000).unref()

/** Call this inside emit/emitToWorkspace after broadcasting to SSE clients */
function notifyInternal(event: AgentEvent): void {
    for (const h of internalHandlers) {
        try { h(event) } catch { /* non-fatal */ }
    }
}
