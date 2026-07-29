// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Health-probe data-access repository (read-only).
 *
 * owns the lightweight liveness/diagnostic reads behind the
 * /health route: the postgres ping, the workspace-id probe sample, the
 * registered-app-profile count, and the PEX prompt/context aggregate counts.
 * The route keeps the latency timing, Promise.allSettled orchestration,
 * Number() coercion, and try/catch (probes are non-fatal).
 */
import { sql, eq, and, isNull } from 'drizzle-orm'
import { db } from '@plexo/db'
import { workspaces, extensionPrompts, extensionContexts, appProfiles } from '@plexo/db'

/** Trivial connectivity ping. */
export async function pingDb(): Promise<void> {
    await db.execute(sql`SELECT 1`)
}

/** First few workspace ids (probe sample for AI-provider ping). */
export async function listWorkspaceIdsSample(limit: number) {
    return db.select({ id: workspaces.id }).from(workspaces).limit(limit)
}

/** Registered app-profile count row. */
export async function getRegisteredProfileCount() {
    const [row] = await db.select({ count: sql<number>`count(*)` }).from(appProfiles)
    return row
}

/** PEX prompt/context aggregate counts — [pTotal, pEnabled, cTotal, cEnabled]. */
export async function getPexCounts() {
    return Promise.all([
        db.select({ count: sql<number>`count(*)` }).from(extensionPrompts).where(isNull(extensionPrompts.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(extensionPrompts).where(and(eq(extensionPrompts.enabled, true), isNull(extensionPrompts.deletedAt))),
        db.select({ count: sql<number>`count(*)` }).from(extensionContexts).where(isNull(extensionContexts.deletedAt)),
        db.select({ count: sql<number>`count(*)` }).from(extensionContexts).where(and(eq(extensionContexts.enabled, true), isNull(extensionContexts.deletedAt))),
    ])
}
