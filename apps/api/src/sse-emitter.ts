// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Response } from 'express'
import { getRedis, isRedisAvailable, markRedisDown } from './redis-client.js'

/** Connected SSE clients — keyed by workspace ID, then a unique connection ID */
const clients = new Map<string, Map<string, Response>>()
let connId = 0

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

/** Emit an event to all connected clients for a workspace */
export function emitToWorkspace(workspaceId: string, event: AgentEvent): void {
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

    // Write delivery ack for OWD events when at least one SSE client received it
    if (delivered && event.taskId && (event.type === 'owd_pending' || (event as Record<string, unknown>).operation)) {
        writeDeliveryAck(String(event.taskId)).catch(() => {})
    }

    // Always notify internal subscribers (Telegram, Slack adapters) regardless
    // of whether any SSE clients are connected.
    notifyInternal(event)
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
    let total = 0
    for (const workspace of clients.values()) total += workspace.size
    return total
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
