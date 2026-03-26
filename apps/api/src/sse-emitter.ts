// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Response } from 'express'

/** Connected SSE clients — keyed by workspace ID, then a unique connection ID */
const clients = new Map<string, Map<string, Response>>()
let connId = 0

export function registerClient(workspaceId: string, res: Response): string {
    const id = String(++connId)
    if (!clients.has(workspaceId)) {
        clients.set(workspaceId, new Map())
    }
    clients.get(workspaceId)!.set(id, res)
    return id
}

export function unregisterClient(workspaceId: string, id: string): void {
    clients.get(workspaceId)?.delete(id)
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
                workspace.delete(id)
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
    try {
        const { createClient } = await import('redis')
        const redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' })
        await redis.connect()
        await redis.set(`owd:${taskId}:ack`, '1', { EX: 300 })
        await redis.disconnect()
    } catch { /* non-fatal */ }
}

/** Emit an event to all connected clients across all workspaces */
export function emit(event: AgentEvent): void {
    const data = `data: ${JSON.stringify(event)}\n\n`
    for (const workspace of clients.values()) {
        for (const [id, res] of workspace) {
            try {
                res.write(data)
            } catch {
                workspace.delete(id)
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

/** Call this inside emit/emitToWorkspace after broadcasting to SSE clients */
function notifyInternal(event: AgentEvent): void {
    for (const h of internalHandlers) {
        try { h(event) } catch { /* non-fatal */ }
    }
}
