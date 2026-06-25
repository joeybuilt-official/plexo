// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * delivery-tracker.ts
 *
 * Fire-and-forget recording of every outbound message send to external channels.
 * Never blocks the message flow — failures are logged but swallowed.
 */

import { desc, sql, and, eq } from 'drizzle-orm'
import { db } from '@plexo/db'
import { messageDeliveries } from '@plexo/db'
import { ulid } from 'ulid'
import { logger } from './logger.js'

export interface DeliveryRecord {
    workspaceId: string
    channel: 'telegram' | 'slack' | 'discord' | 'webchat' | 'api' | 'widget'
    chatId: string
    status: 'sent' | 'failed' | 'rejected' | 'empty_response'
    errorMessage?: string | null
    messageLength: number
    latencyMs?: number | null
    conversationId?: string | null
    markdownRetry?: boolean
}

/**
 * Record a delivery attempt. Fire-and-forget — never throws.
 */
export function trackDelivery(record: DeliveryRecord): void {
    const id = ulid()
    db.insert(messageDeliveries).values({
        id,
        workspaceId: record.workspaceId,
        channel: record.channel,
        chatId: String(record.chatId),
        status: record.status,
        errorMessage: record.errorMessage ?? null,
        messageLength: record.messageLength,
        latencyMs: record.latencyMs ?? null,
        conversationId: record.conversationId ?? null,
        markdownRetry: record.markdownRetry ?? false,
    }).catch((err) => {
        logger.warn({ err, channel: record.channel, status: record.status }, 'Failed to record message delivery')
    })
}

export interface DeliveryQueryParams {
    workspaceId?: string
    channel?: string
    status?: string
    limit?: number
    offset?: number
}

/**
 * Query recent deliveries with optional filters.
 */
export async function queryDeliveries(params: DeliveryQueryParams) {
    const lim = Math.min(params.limit ?? 50, 200)
    const off = params.offset ?? 0

    const conditions = []
    if (params.workspaceId) conditions.push(eq(messageDeliveries.workspaceId, params.workspaceId))
    if (params.channel) conditions.push(eq(messageDeliveries.channel, params.channel))
    if (params.status) conditions.push(eq(messageDeliveries.status, params.status))

    const query = db.select().from(messageDeliveries)
        .orderBy(desc(messageDeliveries.createdAt))
        .limit(lim)
        .offset(off)

    if (conditions.length > 0) {
        return query.where(and(...conditions))
    }
    return query
}
