// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Federation Event Processor
 *
 * Polls node_events for unprocessed inbound federation events and dispatches them
 * into the local Plexo runtime:
 *
 *   agent.route  → @plexo/queue push() — creates a new queued task
 *   memory.push  → @plexo/agent/memory/store storeMemory() — persists to memory_entries
 *
 * Unknown event types are marked processed and logged (dropped gracefully).
 * Runs on a 15-second interval; stops cleanly on SIGTERM via stopEventProcessor().
 */

import { eq, and } from 'drizzle-orm'
import { db } from '@plexo/db'
import { nodeEvents } from '@plexo/db'
import { push } from '@plexo/queue'
import { storeMemory, type MemoryType } from '@plexo/agent/memory/store'
import { logger } from '../logger.js'

const POLL_INTERVAL_MS = 15_000
const BATCH_SIZE = 20

const VALID_MEMORY_TYPES = new Set<string>(['task', 'incident', 'session', 'pattern'])

let _timer: ReturnType<typeof setInterval> | null = null
let _running = false

async function processNextBatch(): Promise<void> {
    if (_running) return
    _running = true

    try {
        const events = await db
            .select()
            .from(nodeEvents)
            .where(eq(nodeEvents.processed, false))
            .limit(BATCH_SIZE)

        for (const event of events) {
            try {
                await dispatch(event)
                await db
                    .update(nodeEvents)
                    .set({ processed: true })
                    .where(eq(nodeEvents.id, event.id))
            } catch (err) {
                logger.error({ err, eventId: event.id, eventType: event.eventType }, 'Federation event dispatch failed — will retry')
                // Don't mark processed — will retry on next poll
            }
        }
    } catch (err) {
        logger.error({ err }, 'Federation event processor poll failed')
    } finally {
        _running = false
    }
}

async function dispatch(event: typeof nodeEvents.$inferSelect): Promise<void> {
    const { eventType, payload, sourceNodeDid } = event
    const data = payload as Record<string, unknown>

    if (eventType === 'agent.route') {
        const workspaceId = (data.workspaceId ?? event.workspaceId) as string | null
        if (!workspaceId) {
            logger.warn({ eventId: event.id }, 'agent.route event missing workspaceId — skipping')
            return
        }

        const taskId = await push({
            workspaceId,
            type: 'general',
            source: 'api',
            context: {
                prompt: data.prompt,
                ...((data.context as Record<string, unknown>) ?? {}),
                federatedFrom: sourceNodeDid,
                callbackUrl: data.callbackUrl ?? null,
                federationEventId: event.id,
            },
        })

        logger.info({ eventId: event.id, taskId, workspaceId, sourceDid: sourceNodeDid }, 'Federated agent.route dispatched as task')
        return
    }

    if (eventType === 'memory.push') {
        const workspaceId = (data.workspaceId ?? event.workspaceId) as string | null
        if (!workspaceId) {
            logger.warn({ eventId: event.id }, 'memory.push event missing workspaceId — skipping')
            return
        }

        const rawType = data.type as string | undefined
        const memType: MemoryType = VALID_MEMORY_TYPES.has(rawType ?? '') ? rawType as MemoryType : 'session'

        await storeMemory({
            workspaceId,
            type: memType,
            content: data.content as string,
            metadata: {
                ...((data.metadata as Record<string, unknown>) ?? {}),
                tags: data.tags ?? [],
                federatedFrom: sourceNodeDid,
                federationEventId: event.id,
            },
        })

        logger.info({ eventId: event.id, workspaceId, sourceDid: sourceNodeDid }, 'Federated memory.push stored')
        return
    }

    // Unknown event type — mark processed and log
    logger.warn({ eventId: event.id, eventType }, 'Federation event type not handled — marking processed and dropping')
}

export function startEventProcessor(): void {
    if (_timer) return
    _timer = setInterval(() => { void processNextBatch() }, POLL_INTERVAL_MS)
    // Run immediately on start
    void processNextBatch()
    logger.info('Federation event processor started')
}

export function stopEventProcessor(): void {
    if (_timer) {
        clearInterval(_timer)
        _timer = null
    }
    logger.info('Federation event processor stopped')
}
