import { db, sql, desc, eq, and, gte, ilike } from '@plexo/db'
import { extensionRegistry } from '@plexo/db'

const NOT_DEPRECATED = eq(extensionRegistry.deprecated, false)

export async function getFeatured(limit = 6) {
    return db.select()
        .from(extensionRegistry)
        .where(NOT_DEPRECATED)
        .orderBy(desc(extensionRegistry.installCount))
        .limit(limit)
}

/** Featured items filtered by manifest type (e.g., "agent"). */
export async function getFeaturedByType(type: string, limit = 6) {
    const rows = await db.execute(sql`
        SELECT * FROM extension_registry
        WHERE NOT deprecated
          AND manifest->>'type' = ${type}
        ORDER BY install_count DESC
        LIMIT ${limit}
    `)
    return rows as unknown as Array<{
        id: string
        name: string
        displayName?: string
        display_name?: string
        description: string
        publisher: string
        installCount?: number
        install_count?: number
        manifest: unknown
        iconUrl?: string | null
        icon_url?: string | null
    }>
}

/** Counts of active (non-deprecated) extensions grouped by manifest type. */
export async function getTypeCounts() {
    const rows = await db.execute<{ type: string; count: number }>(sql`
        SELECT COALESCE(manifest->>'type', 'skill') AS type, count(*)::int AS count
        FROM extension_registry
        WHERE NOT deprecated
        GROUP BY type
        ORDER BY count DESC
    `)
    return rows
}

export async function getRecent(limit = 6) {
    return db.select()
        .from(extensionRegistry)
        .where(NOT_DEPRECATED)
        .orderBy(desc(extensionRegistry.updatedAt))
        .limit(limit)
}

export async function getCategories() {
    const rows = await db.execute<{ category: string; count: number }>(sql`
        SELECT category, count(*)::int AS count
        FROM extension_registry
        WHERE NOT deprecated
        GROUP BY category
        ORDER BY count DESC
    `)
    return rows
}

export async function getBySlug(slug: string) {
    const [row] = await db.select()
        .from(extensionRegistry)
        .where(and(eq(extensionRegistry.name, decodeURIComponent(slug)), NOT_DEPRECATED))
        .limit(1)
    return row ?? null
}

export async function getByPublisher(publisher: string) {
    return db.select()
        .from(extensionRegistry)
        .where(and(eq(extensionRegistry.publisher, publisher), NOT_DEPRECATED))
        .orderBy(desc(extensionRegistry.installCount))
}

type ListOpts = {
    category?: string
    type?: string
    q?: string
    sort?: 'popular' | 'recent' | 'trending'
    page?: number
    limit?: number
}

export async function listExtensions(opts: ListOpts) {
    const { category, type, q, sort = 'popular', page = 1, limit = 20 } = opts
    const offset = (page - 1) * limit

    // Build conditions array for AND
    const conditions = [sql`NOT deprecated`]
    if (category && category !== 'all') {
        conditions.push(sql`category = ${category}`)
    }
    if (type && type !== 'all') {
        conditions.push(sql`manifest->>'type' = ${type}`)
    }
    if (q) {
        conditions.push(sql`search_vector @@ plainto_tsquery('english', ${q})`)
    }

    const where = sql.join(conditions, sql` AND `)

    const orderClause = sort === 'recent'
        ? sql`updated_at DESC`
        : sort === 'trending'
            ? sql`(install_count::float / GREATEST(EXTRACT(EPOCH FROM (NOW() - updated_at)) / 86400, 1)) DESC`
            : sql`install_count DESC`

    const rows = await db.execute(sql`
        SELECT * FROM extension_registry
        WHERE ${where}
        ORDER BY ${orderClause}
        LIMIT ${limit} OFFSET ${offset}
    `)

    const [countRow] = await db.execute<{ total: number }>(sql`
        SELECT count(*)::int AS total FROM extension_registry
        WHERE ${where}
    `)

    return {
        items: rows,
        total: countRow?.total ?? 0,
        page,
        pageCount: Math.ceil((countRow?.total ?? 0) / limit),
    }
}

export async function getStats() {
    const [row] = await db.execute<{ total: number; installs: number; publishers: number }>(sql`
        SELECT
            count(*)::int AS total,
            coalesce(sum(install_count), 0)::int AS installs,
            count(DISTINCT publisher)::int AS publishers
        FROM extension_registry
        WHERE NOT deprecated
    `)
    return row ?? { total: 0, installs: 0, publishers: 0 }
}

export async function search(query: string, limit = 20) {
    return db.execute(sql`
        SELECT *, ts_rank(search_vector, plainto_tsquery('english', ${query})) AS rank
        FROM extension_registry
        WHERE NOT deprecated
          AND search_vector @@ plainto_tsquery('english', ${query})
        ORDER BY rank DESC
        LIMIT ${limit}
    `)
}
