// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase α regression — `link.note_to_note` count must not drop after the
 * Phase 1 refactor that switched generateLinkSuggestions from O(n²) pairwise
 * scan to a kNN-edge reader.
 *
 * Asserts: at least 7 link.note_to_note suggestions are produced for the
 * given workspace once cluster + suggest are run on the existing corpus.
 *
 * Run inside the API container:
 *     docker exec -i plexo-api node \
 *         --import tsx /app/apps/api/src/scripts/synthesis-regression.ts <workspaceId>
 */
import { db, sql } from '@plexo/db'
import { clusterMemory } from '@plexo/agent/memory/cluster'
import { generateLinkSuggestions, generateThemeSuggestions } from '@plexo/agent/memory/suggest'

const MIN_LINK_SUGGESTIONS = 7

async function main(): Promise<void> {
    const workspaceId = process.argv[2]
    if (!workspaceId) {
        console.error('usage: synthesis-regression <workspaceId>')
        process.exit(1)
    }

    console.log(`synthesis-regression: workspace=${workspaceId}`)

    // 1) Cluster (refreshes kNN edges).
    console.log('clustering…')
    const cluster = await clusterMemory(workspaceId)
    console.log(`  summary=${JSON.stringify(cluster.summary)} duration=${cluster.durationMs}ms`)

    // 2) Suggest.
    console.log('suggesting (themes)…')
    const themeRes = await generateThemeSuggestions(workspaceId)
    console.log(`  themes inserted=${themeRes.inserted} skipped=${themeRes.skipped} inspected=${themeRes.inspected}`)

    console.log('suggesting (links)…')
    const linkRes = await generateLinkSuggestions(workspaceId)
    console.log(`  links inserted=${linkRes.inserted} skipped=${linkRes.skipped} inspectedPairs=${linkRes.inspectedPairs}`)

    // 3) Count pending link.note_to_note suggestions in the inbox.
    const rows = Array.from(await db.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n
        FROM synthesis_suggestions
        WHERE workspace_id = ${workspaceId}::uuid
          AND kind = 'link.note_to_note'
          AND status = 'pending'
    `))
    const n = rows[0]?.n ?? 0

    console.log(`pending link.note_to_note suggestions: ${n}`)
    if (n < MIN_LINK_SUGGESTIONS) {
        console.error(`REGRESSION: expected at least ${MIN_LINK_SUGGESTIONS} suggestions, got ${n}`)
        process.exit(1)
    }
    console.log('OK — Phase α regression bar met')
}

main().catch(err => {
    console.error('synthesis-regression failed:', err)
    process.exit(1)
})
