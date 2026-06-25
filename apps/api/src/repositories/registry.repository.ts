// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extension-registry (marketplace) data-access repository.
 *
 * owns the extension_registry reads/writes behind the
 * registry routes. The route keeps auth, manifest validation, signature
 * handling, publisher-ownership checks, and tag filtering.
 */
import { db, eq, and, ne, ilike } from '@plexo/db'
import { extensionRegistry } from '@plexo/db'

export interface SearchRegistryFilter {
    q?: string
    publisher?: string
    limit: number
    offset: number
}

/** Non-deprecated registry rows matching name/publisher (tag filtered in-route). */
export async function search(filter: SearchRegistryFilter) {
    const { q, publisher, limit, offset } = filter
    const conditions = [
        eq(extensionRegistry.deprecated, false),
        ...(q ? [ilike(extensionRegistry.name, `%${q}%`)] : []),
        ...(publisher ? [eq(extensionRegistry.publisher, publisher)] : []),
    ]
    return db
        .select({
            name: extensionRegistry.name,
            displayName: extensionRegistry.displayName,
            description: extensionRegistry.description,
            publisher: extensionRegistry.publisher,
            latestVersion: extensionRegistry.latestVersion,
            tags: extensionRegistry.tags,
            installCount: extensionRegistry.installCount,
            publishedAt: extensionRegistry.publishedAt,
            updatedAt: extensionRegistry.updatedAt,
        })
        .from(extensionRegistry)
        .where(and(...conditions))
        .limit(limit)
        .offset(offset)
}

/** Full registry entry by name. */
export async function getByName(name: string) {
    const [entry] = await db
        .select()
        .from(extensionRegistry)
        .where(eq(extensionRegistry.name, name))
        .limit(1)
    return entry
}

/** Publish-time ownership snapshot (id, versions, publisher) for an entry. */
export async function getPublishMeta(name: string) {
    const [entry] = await db
        .select({ id: extensionRegistry.id, versions: extensionRegistry.versions, publisher: extensionRegistry.publisher })
        .from(extensionRegistry)
        .where(eq(extensionRegistry.name, name))
        .limit(1)
    return entry
}

/** Active (non-deprecated) entry ownership snapshot for a name. */
export async function getActiveByName(name: string) {
    const [entry] = await db
        .select({ id: extensionRegistry.id, publisher: extensionRegistry.publisher })
        .from(extensionRegistry)
        .where(and(eq(extensionRegistry.name, name), ne(extensionRegistry.deprecated, true)))
        .limit(1)
    return entry
}

/** Overwrite a registry entry by id with the supplied column set. */
export async function updateById(id: string, values: Record<string, unknown>) {
    await db.update(extensionRegistry).set(values).where(eq(extensionRegistry.id, id))
}

/** Insert a new registry entry. */
export async function insertEntry(values: typeof extensionRegistry.$inferInsert) {
    await db.insert(extensionRegistry).values(values)
}
