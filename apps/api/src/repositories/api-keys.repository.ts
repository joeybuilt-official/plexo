// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * API key (MCP token) data-access repository.
 *
 * arch-findings B1 — owns all mcp_tokens persistence for the api-keys routes.
 * Token generation/hashing stays in the route handler (business logic); only the
 * reads/writes live here. Revocation is scoped by workspaceId (object-level authz
 * preserved).
 */
import { db, eq, and, desc } from '@plexo/db'
import { mcpTokens } from '@plexo/db'

export interface ApiKeyListRow {
    id: string
    name: string
    scopes: string[] | null
    type: string
    createdAt: Date
    lastUsedAt: Date | null
}

/** Active (non-revoked) API keys for a workspace, newest first. */
export async function listActiveKeys(workspaceId: string): Promise<ApiKeyListRow[]> {
    return db
        .select({
            id: mcpTokens.id,
            name: mcpTokens.name,
            scopes: mcpTokens.scopes,
            type: mcpTokens.type,
            createdAt: mcpTokens.createdAt,
            lastUsedAt: mcpTokens.lastUsedAt,
        })
        .from(mcpTokens)
        .where(and(eq(mcpTokens.workspaceId, workspaceId), eq(mcpTokens.revoked, false)))
        .orderBy(desc(mcpTokens.createdAt)) as Promise<ApiKeyListRow[]>
}

export interface CreateApiKeyInput {
    workspaceId: string
    name: string
    tokenHash: string
    tokenSalt: string
    scopes: string[]
}

export interface CreatedApiKey {
    id: string
    name: string
    createdAt: Date
}

/** Persist a new MCP token (hash + salt) and return its public fields. */
export async function createKey(input: CreateApiKeyInput): Promise<CreatedApiKey | undefined> {
    const [created] = await db
        .insert(mcpTokens)
        .values({
            workspaceId: input.workspaceId,
            name: input.name,
            tokenHash: input.tokenHash,
            tokenSalt: input.tokenSalt,
            scopes: input.scopes,
            type: 'mcp',
        })
        .returning({ id: mcpTokens.id, name: mcpTokens.name, createdAt: mcpTokens.createdAt })
    return created
}

/** Revoke a key, scoped to the owning workspace (object-level authz). */
export async function revokeKey(workspaceId: string, keyId: string): Promise<void> {
    await db
        .update(mcpTokens)
        .set({ revoked: true })
        .where(and(eq(mcpTokens.id, keyId), eq(mcpTokens.workspaceId, workspaceId)))
}
