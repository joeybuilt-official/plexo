// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * A2A (agent-to-agent) data-access repository.
 *
 * arch-findings B1 — owns the extension/task/mcp-token reads and the external-
 * agent registration writes. The route keeps Bearer auth (timing-safe compare),
 * agent-card building, SSRF checks, status mapping, and queue orchestration.
 * Object-level authz (workspace match on tasks) stays in the route.
 */
import { db, eq, and } from '@plexo/db'
import { extensions, tasks, workspaces, mcpTokens } from '@plexo/db'

/** Enabled agent-type extensions for a workspace. */
export async function listAgentExtensions(workspaceId: string) {
    return db
        .select()
        .from(extensions)
        .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.type, 'agent'), eq(extensions.enabled, true)))
}

/** A single agent-type extension by id. */
export async function getAgentExtension(id: string) {
    const [ext] = await db
        .select()
        .from(extensions)
        .where(and(eq(extensions.id, id), eq(extensions.type, 'agent')))
        .limit(1)
    return ext
}

/** All non-revoked MCP tokens (hash/salt/workspace) for Bearer key matching. */
export async function listActiveTokens() {
    return db
        .select({ tokenHash: mcpTokens.tokenHash, tokenSalt: mcpTokens.tokenSalt, workspaceId: mcpTokens.workspaceId })
        .from(mcpTokens)
        .where(eq(mcpTokens.revoked, false))
}

/** Stamp lastUsedAt on a token (audit trail). Returns the promise for caller .catch. */
export function touchTokenLastUsed(tokenHash: string, tokenSalt: string): Promise<unknown> {
    return db.update(mcpTokens)
        .set({ lastUsedAt: new Date() })
        .where(and(eq(mcpTokens.tokenHash, tokenHash), eq(mcpTokens.tokenSalt, tokenSalt)))
}

/** A task by id. */
export async function getTask(id: string) {
    const [task] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    return task
}

/** Child tasks (sub-agent delegation) of a parent. */
export async function listChildTasks(parentId: string) {
    return db
        .select({ id: tasks.id, status: tasks.status, outcomeSummary: tasks.outcomeSummary })
        .from(tasks)
        .where(eq(tasks.parentId, parentId))
}

/** Existing extension id by (workspace, name). */
export async function getExtensionByName(workspaceId: string, name: string): Promise<{ id: string } | undefined> {
    const [existing] = await db
        .select({ id: extensions.id })
        .from(extensions)
        .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.name, name)))
        .limit(1)
    return existing
}

/** Update an external agent's manifest and re-enable it. */
export async function updateExternalAgent(id: string, manifest: Record<string, unknown>): Promise<void> {
    await db.update(extensions)
        .set({ manifest, enabled: true })
        .where(eq(extensions.id, id))
}

/** Insert a freshly registered external agent extension. */
export async function insertExternalAgent(values: typeof extensions.$inferInsert): Promise<{ id: string }> {
    const [row] = await db.insert(extensions).values(values).returning({ id: extensions.id })
    return row!
}

/** First workspace id (well-known default agent listing). */
export async function getFirstWorkspaceId(): Promise<{ id: string } | undefined> {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1)
    return ws
}
