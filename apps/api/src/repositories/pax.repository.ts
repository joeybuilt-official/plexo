// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PAX (Plexo Application eXchange) registration data-access repository.
 *
 * owns the pax_registrations / mcp_tokens reads and writes
 * behind the PAX register/rotate/revoke routes. The route keeps manifest
 * validation, the capability-ceiling check, token generation/hashing, audit
 * logging, and response shaping.
 */
import { eq, and } from 'drizzle-orm'
import { db } from '@plexo/db'
import { paxRegistrations, mcpTokens, workspaces } from '@plexo/db'

/** {id} of a workspace by id, or undefined. */
export async function getWorkspaceId(workspaceId: string) {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return ws
}

/** Existing PAX registration {id} for (workspace, appName), or undefined. */
export async function getRegistrationId(workspaceId: string, appName: string) {
    const [existing] = await db
        .select({ id: paxRegistrations.id })
        .from(paxRegistrations)
        .where(and(eq(paxRegistrations.workspaceId, workspaceId), eq(paxRegistrations.appName, appName)))
        .limit(1)
    return existing
}

/** Full PAX registration row for (workspace, appName), or undefined. */
export async function getRegistration(workspaceId: string, appName: string) {
    const [reg] = await db
        .select()
        .from(paxRegistrations)
        .where(and(eq(paxRegistrations.workspaceId, workspaceId), eq(paxRegistrations.appName, appName)))
        .limit(1)
    return reg
}

/** Insert an mcp_token, returning {id}. */
export async function insertMcpToken(values: typeof mcpTokens.$inferInsert) {
    const [tokenRow] = await db.insert(mcpTokens).values(values).returning({ id: mcpTokens.id })
    return tokenRow
}

/** Insert a PAX registration. */
export async function insertRegistration(values: typeof paxRegistrations.$inferInsert): Promise<void> {
    await db.insert(paxRegistrations).values(values)
}

/** Mark an mcp_token revoked by id. */
export async function revokeMcpToken(tokenId: string): Promise<void> {
    await db.update(mcpTokens).set({ revoked: true }).where(eq(mcpTokens.id, tokenId))
}

/** Apply a partial update to a PAX registration by id. */
export async function updateRegistration(id: string, set: Partial<typeof paxRegistrations.$inferInsert>): Promise<void> {
    await db.update(paxRegistrations).set(set).where(eq(paxRegistrations.id, id))
}
