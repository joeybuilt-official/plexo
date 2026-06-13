// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * App Service Keys data-access repository — A3 Phase 7.
 *
 * Hashed per-app service keys (SHA-256 + per-token salt) that replace the
 * shared PLEXO_SERVICE_KEY. Raw token is shown ONCE on issue; only the hash
 * + salt persist. listKeys() never returns hash/salt.
 */
import { db, eq, desc } from '@plexo/db'
import { appServiceKeys } from '@plexo/db'

/** List keys, optionally filtered by appId. Never returns tokenHash/tokenSalt. */
export async function listKeys(opts: { appId?: string } = {}) {
    const base = db
        .select({
            id: appServiceKeys.id,
            appId: appServiceKeys.appId,
            name: appServiceKeys.name,
            revoked: appServiceKeys.revoked,
            expiresAt: appServiceKeys.expiresAt,
            lastUsedAt: appServiceKeys.lastUsedAt,
            createdAt: appServiceKeys.createdAt,
            createdBy: appServiceKeys.createdBy,
        })
        .from(appServiceKeys)
    const rows = opts.appId
        ? await base.where(eq(appServiceKeys.appId, opts.appId)).orderBy(desc(appServiceKeys.createdAt))
        : await base.orderBy(desc(appServiceKeys.createdAt))
    return rows
}

/** Lookup by token hash for Phase 8 dual-accept auth path. Includes salt. */
export async function findByHash(tokenHash: string) {
    const rows = await db
        .select({
            id: appServiceKeys.id,
            appId: appServiceKeys.appId,
            revoked: appServiceKeys.revoked,
            expiresAt: appServiceKeys.expiresAt,
            tokenSalt: appServiceKeys.tokenSalt,
        })
        .from(appServiceKeys)
        .where(eq(appServiceKeys.tokenHash, tokenHash))
        .limit(1)
    return rows[0] ?? null
}

/** Insert a new key row; returns the new id. */
export async function insertKey(params: {
    appId: string
    name: string
    tokenHash: string
    tokenSalt: string
    expiresAt: Date | null
    createdBy: string | null
}): Promise<{ id: string }> {
    const { appId, name, tokenHash, tokenSalt, expiresAt, createdBy } = params
    const rows = await db
        .insert(appServiceKeys)
        .values({ appId, name, tokenHash, tokenSalt, expiresAt, createdBy })
        .returning({ id: appServiceKeys.id })
    const row = rows[0]
    if (!row) throw new Error('insertKey: no row returned')
    return { id: row.id }
}

/** Revoke a key (idempotent — sets revoked=true). */
export async function revokeKey(id: string): Promise<void> {
    await db.update(appServiceKeys).set({ revoked: true }).where(eq(appServiceKeys.id, id))
}

/** Minimal row by id — used by rotate/revoke flows. */
export async function getById(id: string) {
    const rows = await db
        .select({
            id: appServiceKeys.id,
            appId: appServiceKeys.appId,
            name: appServiceKeys.name,
            revoked: appServiceKeys.revoked,
        })
        .from(appServiceKeys)
        .where(eq(appServiceKeys.id, id))
        .limit(1)
    return rows[0] ?? null
}
