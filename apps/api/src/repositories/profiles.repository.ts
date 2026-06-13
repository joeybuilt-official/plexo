// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * App-profiles data-access repository.
 *
 * arch-findings B1 — owns the `app_profiles` and `extension_registry` SQL
 * behind the profile-registration routes. The route keeps the service-key auth,
 * Zod validation, profile negotiation, and response shaping. Only the SQL moves
 * here; the upsert-on-app_id semantics and append-never-overwrite extension
 * batch are preserved verbatim.
 */
import { db, eq, sql } from '@plexo/db'
import { appProfiles, extensionRegistry } from '@plexo/db'

/** Registered app profiles (id/namespace/displayName/lastSeen), ordered by registration. */
export function listProfiles() {
    return db
        .select({
            appId: appProfiles.appId,
            schemaNamespace: appProfiles.schemaNamespace,
            displayName: appProfiles.displayName,
            lastSeenAt: appProfiles.lastSeenAt,
        })
        .from(appProfiles)
        .orderBy(appProfiles.registeredAt)
}

/** Upsert an app profile on app_id (display/contracts/last-seen). */
export async function upsertProfile(params: {
    appId: string
    schemaNamespace: string
    displayName: string
    eventContracts: string[]
}): Promise<void> {
    await db
        .insert(appProfiles)
        .values({
            appId: params.appId,
            schemaNamespace: params.schemaNamespace,
            displayName: params.displayName,
            eventContracts: params.eventContracts,
            lastSeenAt: new Date(),
        })
        .onConflictDoUpdate({
            target: appProfiles.appId,
            set: {
                displayName: params.displayName,
                eventContracts: params.eventContracts,
                lastSeenAt: new Date(),
            },
        })
}

/** Batch-upsert extension-registry rows on name (append-never-overwrite via excluded.*). */
export async function upsertExtensions(values: Array<typeof extensionRegistry.$inferInsert>): Promise<void> {
    await db
        .insert(extensionRegistry)
        .values(values)
        .onConflictDoUpdate({
            target: extensionRegistry.name,
            set: {
                displayName: sql`excluded.display_name`,
                description: sql`excluded.description`,
                manifest: sql`excluded.manifest`,
                tags: sql`excluded.tags`,
                updatedAt: new Date(),
            },
        })
}

/** Touch an app profile's last_seen_at by app_id. */
export async function touchLastSeen(appId: string): Promise<void> {
    await db
        .update(appProfiles)
        .set({ lastSeenAt: new Date() })
        .where(eq(appProfiles.appId, appId))
}
