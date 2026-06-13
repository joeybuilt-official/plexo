// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Cross-app handoff token data-access repository.
 *
 * arch-findings B1 — owns the auth.cross_app_tokens insert/consume queries.
 * The route keeps auth, target-app validation, token minting, and redirects.
 */
import { db, sql } from '@plexo/db'

export interface HandoffTokenRow extends Record<string, unknown> {
    user_id: string
    source_app: string
    target_app: string
}

/** Insert a single-use cross-app token (source always 'plexo'). */
export async function insertToken(token: string, userId: string, targetApp: string, expiresAtIso: string): Promise<void> {
    await db.execute(sql`
        INSERT INTO auth.cross_app_tokens (token, user_id, source_app, target_app, expires_at)
        VALUES (${token}, ${userId}::uuid, 'plexo', ${targetApp}, ${expiresAtIso})
    `)
}

/** Atomically burn a token if valid; returns the claimed row(s). */
export async function consumeToken(token: string): Promise<HandoffTokenRow[]> {
    return db.execute<HandoffTokenRow>(sql`
        UPDATE auth.cross_app_tokens
        SET used = true
        WHERE token = ${token}
          AND used = false
          AND expires_at > now()
        RETURNING user_id, source_app, target_app
    `)
}
