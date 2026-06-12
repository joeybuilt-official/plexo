// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channels data-access repository.
 *
 * arch-findings B1 — owns the channels table reads/writes. The route keeps
 * config encryption/decryption, webhook auth, and dispatch orchestration.
 */
import { db, eq } from '@plexo/db'
import { channels } from '@plexo/db'

/** Full channel row by id, or undefined. */
export async function getById(channelId: string) {
    const [row] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
    return row
}
