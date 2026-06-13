// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channels data-access repository.
 *
 * arch-findings B1 — owns the channels table reads/writes. The route keeps
 * config encryption/decryption, webhook auth, and dispatch orchestration.
 */
import { db, eq, and } from '@plexo/db'
import { channels } from '@plexo/db'

/** Full channel row by id, or undefined. */
export async function getById(channelId: string) {
    const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
    return row
}

/** {id,config,workspaceId,enabled} rows for all channels of a given type. */
export async function listByType(type: string) {
    return db
        .select({ id: channels.id, config: channels.config, workspaceId: channels.workspaceId, enabled: channels.enabled })
        .from(channels)
        .where(eq(channels.type, type))
}

/** Descriptor rows for the subscription contract, optionally workspace-scoped. */
export async function listDescriptors(workspaceId?: string) {
    const where = workspaceId ? eq(channels.workspaceId, workspaceId) : undefined
    return db
        .select({
            id: channels.id,
            workspaceId: channels.workspaceId,
            type: channels.type,
            name: channels.name,
            enabled: channels.enabled,
            lastMessageAt: channels.lastMessageAt,
        })
        .from(channels)
        .where(where)
}

/** True when a channel with this id exists. */
export async function existsById(channelId: string): Promise<boolean> {
    const [row] = await db.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).limit(1)
    return !!row
}

/** {id,type,config,enabled} for a channel scoped to a workspace (IDOR guard). */
export async function getEnabledScoped(channelId: string, workspaceId: string): Promise<{ id: string; type: string; config: unknown; enabled: boolean } | undefined> {
    const [row] = await db
        .select({ id: channels.id, type: channels.type, config: channels.config, enabled: channels.enabled })
        .from(channels)
        .where(and(eq(channels.id, channelId), eq(channels.workspaceId, workspaceId)))
        .limit(1)
    return row
}
