#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * One-time backfill script: generate embeddings for existing memory_entries
 * that have NULL embedding columns.
 *
 * MANUAL OPERATION — do NOT run automatically.
 * Operator should verify an embeddings-capable provider is configured before running.
 *
 * Usage:
 *   WORKSPACE_ID=00000000-0000-0000-0000-000000000001 pnpm tsx scripts/backfill-embeddings.ts
 *
 * Options:
 *   --dry-run    Report what would be done without writing
 *   --batch=N    Process N entries at a time (default: 10)
 *   --delay=MS   Delay between batches in ms (default: 500)
 */

import { db, sql } from '@plexo/db'
import { resolveEmbeddingAdapterAsync } from '@plexo/agent/embeddings/router'

const workspaceId = process.env.WORKSPACE_ID
if (!workspaceId) {
    console.error('Error: WORKSPACE_ID env var required')
    process.exit(1)
}

const dryRun = process.argv.includes('--dry-run')
const batchSize = Number(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1] ?? 10)
const delayMs = Number(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1] ?? 500)

async function loadWorkspaceSettings(wsId: string): Promise<WorkspaceAISettings | null> {
    const [row] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, wsId))
        .limit(1)

    const settings = row?.settings as Record<string, unknown> | null
    if (!settings) return null

    const vault = (settings.vault ?? {}) as Record<string, any>
    const arbiter = (settings.arbiter ?? {}) as Record<string, any>

    const providers: Record<string, any> = {}
    for (const [key, entry] of Object.entries(vault)) {
        providers[key] = {
            provider: key,
            apiKey: entry?.apiKey,
            baseUrl: entry?.baseUrl,
            enabled: arbiter?.providers?.[key]?.enabled ?? true,
            model: arbiter?.providers?.[key]?.selectedModel,
        }
    }

    return {
        primaryProvider: (arbiter.primaryProvider ?? 'anthropic') as ProviderKey,
        fallbackChain: (arbiter.fallbackChain ?? []) as ProviderKey[],
        providers,
    }
}

async function main() {
    console.log(`Backfill embeddings for workspace ${workspaceId}`)
    console.log(`  dry-run: ${dryRun}, batch: ${batchSize}, delay: ${delayMs}ms`)

    // Load workspace settings from DB and resolve embedding provider
    const aiSettings = await loadWorkspaceSettings(workspaceId!)
    const resolution = resolveEmbeddingAdapter(workspaceId!, aiSettings)

    if (!resolution.adapter || resolution.status !== 'active') {
        console.error(`No embeddings-capable provider available (status: ${resolution.status})`)
        console.error(resolution.message ?? 'Configure a provider with embedding support and retry.')
        process.exit(1)
    }

    console.log(`  provider: ${resolution.providerId}, model: ${resolution.model}, dims: ${resolution.dimensions}`)

    // Count entries needing backfill
    const [countRow] = await db.execute<{ total: string; missing: string }>(sql`
        SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE embedding IS NULL) AS missing
        FROM memory_entries
        WHERE workspace_id = ${workspaceId}::uuid
    `)

    const total = Number(countRow?.total ?? 0)
    const missing = Number(countRow?.missing ?? 0)
    console.log(`  total entries: ${total}, missing embeddings: ${missing}`)

    if (missing === 0) {
        console.log('Nothing to backfill.')
        process.exit(0)
    }

    if (dryRun) {
        console.log(`[DRY RUN] Would generate ${missing} embeddings using ${resolution.providerId}/${resolution.model}`)
        process.exit(0)
    }

    // Process in batches
    let processed = 0
    let failed = 0

    while (processed + failed < missing) {
        const rows = await db.execute<{ id: string; content: string }>(sql`
            SELECT id, content
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND embedding IS NULL
            ORDER BY created_at ASC
            LIMIT ${batchSize}
        `)

        if (rows.length === 0) break

        for (const row of rows) {
            try {
                const vector = await resolution.adapter!.embed(row.content)
                const vecStr = `[${vector.join(',')}]`
                await db.execute(
                    sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${row.id}::uuid`,
                )
                processed++
                process.stdout.write('.')
            } catch (err) {
                failed++
                console.error(`\nFailed to embed entry ${row.id}: ${err}`)
            }
        }

        if (processed + failed < missing && delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs))
        }
    }

    console.log(`\nDone. Processed: ${processed}, Failed: ${failed}`)
    console.log(`Provider: ${resolution.providerId}, Model: ${resolution.model}, Dimensions: ${resolution.dimensions}`)
}

main().catch(err => {
    console.error('Backfill failed:', err)
    process.exit(1)
})
