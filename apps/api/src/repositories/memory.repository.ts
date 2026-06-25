// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory data-access repository (raw-SQL path).
 *
 * owns the raw `memory_entries`, `behavior_rules`,
 * `agent_improvement_log`, `memory_tier_stats`, and the workspace
 * `intelligence_settings`-for-eviction SQL used by the Memory API. The route
 * keeps every side-effect: embedding generation (`embed`/`storeMemory`),
 * semantic search (`searchMemory`), the self-improvement / prompt-improvement
 * pipelines, decay math, attachment uploads, audit/event tracking, and the
 * eviction validation/merge logic. Only the SQL moves here. All filters stay
 * parameterised (drizzle `sql` template) and every query preserves its
 * `workspace_id` scoping verbatim.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

/** Browse memory_entries with optional type/tier/namespace/text filters + pagination. */
export async function listMemoryEntries(opts: {
    workspaceId: string
    type?: string
    tier?: string
    namespace?: string
    q?: string
    limit: number
    offset: number
}): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
    const { workspaceId, type, tier, namespace, q, limit, offset } = opts

    let query = sql`
        SELECT id, type, content, shorthand, metadata, tier, confidence, namespace, created_at
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
    `
    if (type) query = sql`${query} AND type = ${type}::memory_type`
    if (tier) query = sql`${query} AND tier = ${tier}`
    if (namespace) query = sql`${query} AND namespace = ${namespace}`
    if (q && q.trim()) query = sql`${query} AND content ILIKE ${'%' + q.trim().slice(0, 200) + '%'}`
    query = sql`${query} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`

    const [rows, countResult] = await Promise.all([
        db.execute(query).then(r => Array.from(r)) as Promise<Array<Record<string, unknown>>>,
        db.execute<{ total: number }>(
            sql`SELECT count(*)::int as total FROM memory_entries WHERE workspace_id = ${workspaceId}::uuid`
        ).then(r => Array.from(r)),
    ])
    const total = countResult[0]?.total ?? 0
    return { rows, total }
}

/** Overwrite a memory_entries row's metadata JSONB (post attachment upload). */
export async function updateMemoryEntryMetadata(entryId: string, meta: Record<string, unknown>): Promise<void> {
    await db.execute(sql`
        UPDATE memory_entries SET metadata = ${JSON.stringify(meta)}::jsonb
        WHERE id = ${entryId}::uuid
    `)
}

/** Edit a memory entry's content (workspace-scoped). Returns the affected rows. */
export async function updateMemoryEntryContent(id: string, workspaceId: string, content: string): Promise<Array<{ id: string }>> {
    return Array.from(await db.execute<{ id: string }>(sql`
        UPDATE memory_entries SET content = ${content}
        WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
        RETURNING id
    `))
}

/** Persist a freshly-generated embedding vector onto a memory entry (FUN-030 fire-and-forget). */
export async function updateMemoryEntryEmbedding(id: string, vecStr: string): Promise<void> {
    await db.execute(sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`)
}

/** Delete a memory entry (workspace-scoped). Returns the affected rows. */
export async function deleteMemoryEntry(id: string, workspaceId: string): Promise<Array<{ id: string }>> {
    return Array.from(await db.execute<{ id: string }>(sql`
        DELETE FROM memory_entries
        WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
        RETURNING id
    `))
}

/** Export all non-deleted behavior_rules for a workspace. */
export async function exportBehaviorRules(workspaceId: string): Promise<Array<{
    id: string
    key: string
    type: string
    label: string
    description: string
    value: unknown
    source: string
    tags: string[]
    locked: boolean
    created_at: string
    updated_at: string
}>> {
    const rows = await db.execute<{
        id: string
        key: string
        type: string
        label: string
        description: string
        value: unknown
        source: string
        tags: string[]
        locked: boolean
        created_at: string
        updated_at: string
    }>(sql`
        SELECT id, key, type, label, description, value, source, tags, locked, created_at, updated_at
        FROM behavior_rules
        WHERE workspace_id = ${workspaceId}::uuid
          AND deleted_at IS NULL
        ORDER BY type, key
    `)
    return Array.from(rows)
}

/** Upsert a single behavior_rule (import). Returns the raw drizzle result (rowCount used by caller). */
export async function upsertBehaviorRule(workspaceId: string, rule: {
    key: string
    type: string
    label: string
    description?: string
    value: unknown
    source?: string
    tags?: string[]
    locked?: boolean
}): Promise<unknown> {
    return db.execute(sql`
        INSERT INTO behavior_rules
            (id, workspace_id, type, key, label, description, value, source, tags, locked)
        VALUES
            (gen_random_uuid(), ${workspaceId}::uuid,
             ${rule.type}, ${rule.key}, ${rule.label},
             ${rule.description ?? ''},
             ${JSON.stringify(rule.value ?? {})}::jsonb,
             ${rule.source ?? 'import'},
             ${sql`ARRAY[${sql.join((rule.tags ?? ['imported']).map(t => sql`${t}`), sql`,`)}]::text[]`},
             ${rule.locked ?? false})
        ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
        DO UPDATE SET
            label = EXCLUDED.label,
            description = EXCLUDED.description,
            value = EXCLUDED.value,
            source = EXCLUDED.source,
            tags = EXCLUDED.tags,
            updated_at = now()
    `)
}

/** Fetch an agent_improvement_log row's pattern_type + applied flag (workspace-scoped). */
export async function getImprovementLogEntry(id: string, workspaceId: string): Promise<{ pattern_type: string; applied: boolean } | undefined> {
    const rows = await db.execute<{ pattern_type: string; applied: boolean }>(sql`
        SELECT pattern_type, applied FROM agent_improvement_log
        WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
        LIMIT 1
    `)
    return rows[0]
}

/** Mark an agent_improvement_log row applied (workspace-scoped). */
export async function markImprovementLogApplied(id: string, workspaceId: string): Promise<void> {
    await db.execute(sql`
        UPDATE agent_improvement_log SET applied = true
        WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
    `)
}

/** Update a memory entry's tier (workspace-scoped). Returns the affected rows. */
export async function updateMemoryEntryTier(entryId: string, workspaceId: string, tier: string): Promise<Array<{ id: string }>> {
    return Array.from(await db.execute<{ id: string }>(sql`
        UPDATE memory_entries
        SET tier = ${tier}
        WHERE id = ${entryId}::uuid AND workspace_id = ${workspaceId}::uuid
        RETURNING id
    `))
}

/** Per-namespace tier counts for a workspace. */
export async function getNamespaceStats(workspaceId: string): Promise<Array<{
    namespace: string; total: number; hot: number; active: number; cold: number
}>> {
    return Array.from(await db.execute<{
        namespace: string; total: number; hot: number; active: number; cold: number
    }>(sql`
        SELECT namespace,
               COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE tier = 'hot')::int AS hot,
               COUNT(*) FILTER (WHERE tier = 'active')::int AS active,
               COUNT(*) FILTER (WHERE tier = 'cold')::int AS cold
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
        GROUP BY namespace
        ORDER BY total DESC, namespace ASC
    `))
}

/** Read a workspace's intelligence_settings JSONB (eviction view source). */
export async function getWorkspaceIntelligenceSettings(workspaceId: string): Promise<Array<{ s: Record<string, unknown> | null }>> {
    return Array.from(await db.execute<{ s: Record<string, unknown> | null }>(sql`
        SELECT intelligence_settings AS s
        FROM workspaces
        WHERE id = ${workspaceId}::uuid
        LIMIT 1
    `))
}

/** Merge an eviction block into workspaces.intelligence_settings at `{memory,eviction}`. */
export async function updateWorkspaceEvictionSettings(workspaceId: string, merged: Record<string, unknown>): Promise<void> {
    await db.execute(sql`
        UPDATE workspaces
        SET intelligence_settings = jsonb_set(
            COALESCE(intelligence_settings, '{}'::jsonb),
            '{memory,eviction}',
            ${JSON.stringify(merged)}::jsonb,
            true
        )
        WHERE id = ${workspaceId}::uuid
    `)
}

/** Memory tier-stats heatmap buckets for a workspace. */
export async function getMemoryHeatmap(workspaceId: string): Promise<Array<{
    tier: string
    confidence_band: string
    count: number
    last_decay_at: string | null
}>> {
    const rows = await db.execute<{
        tier: string
        confidence_band: string
        count: number
        last_decay_at: string | null
    }>(sql`
        SELECT tier, confidence_band, count, last_decay_at
        FROM memory_tier_stats
        WHERE workspace_id = ${workspaceId}::uuid
        ORDER BY tier, confidence_band
    `)
    return Array.from(rows)
}
