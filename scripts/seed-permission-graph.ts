#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase C1 (ADR 0022) — one-shot bulk seed of the plexo-permissions
 * FalkorDB graph from postgres workspace_members.
 *
 * Why this exists
 *   The shadow-write code (commit 7f76be9d) only mirrors *new* mutations.
 *   Every membership that existed when the code deployed is
 *   postgres-only in the reconcile script's view, and the daily diff
 *   never goes clean. Run this script once before the day-1 cron
 *   sweep so the 30-day count starts from a fully-populated graph.
 *
 * Idempotent: MERGE-by-id on both endpoints; re-running on a partially
 * seeded graph just SETs the role on the edges that already exist.
 *
 * Usage:
 *   PLEXO_GRAPHITI_SIDECAR_URL=http://127.0.0.1:8090 \
 *   PLEXO_SERVICE_KEY=<...> \
 *   DATABASE_URL=postgres://... \
 *   pnpm tsx scripts/seed-permission-graph.ts
 *
 *   Options:
 *     --dry-run     Report row count only; do not call the sidecar.
 *     --batch=N     Members per batched cypher call (default 200).
 *     --delay-ms=MS Pause between batches (default 50).
 */

import { db } from '@plexo/db'
import { workspaceMembers } from '@plexo/db'
import { GraphitiClient } from '@plexo/graphiti-bridge'

const PERMISSION_GRAPH_NAME = 'plexo-permissions'

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const BATCH = (() => {
    const a = args.find((s) => s.startsWith('--batch='))
    return a ? Math.max(1, Number(a.split('=')[1])) : 200
})()
const DELAY_MS = (() => {
    const a = args.find((s) => s.startsWith('--delay-ms='))
    return a ? Math.max(0, Number(a.split('=')[1])) : 50
})()

interface Row {
    userId: string
    workspaceId: string
    role: string
}

async function loadAll(): Promise<Row[]> {
    const rows = await db
        .select({
            userId: workspaceMembers.userId,
            workspaceId: workspaceMembers.workspaceId,
            role: workspaceMembers.role,
        })
        .from(workspaceMembers)
    return rows.map((r) => ({ userId: r.userId, workspaceId: r.workspaceId, role: r.role }))
}

async function seedBatch(client: GraphitiClient, batch: Row[]): Promise<boolean> {
    // UNWIND lets us do the whole batch in a single roundtrip without
    // string-interpolating cypher (params keep the workspace lock short
    // and avoid injection risk if a role string ever changes shape).
    const result = await client.cypher({
        workspaceId: PERMISSION_GRAPH_NAME,
        cypher: `
            UNWIND $rows AS row
            MERGE (u:User {id: row.userId})
            MERGE (w:Workspace {id: row.workspaceId})
            MERGE (u)-[r:MEMBER_OF]->(w)
            SET r.role = row.role
        `,
        params: { rows: batch },
    })
    return result !== null
}

async function main(): Promise<number> {
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) {
        console.error('missing env: PLEXO_GRAPHITI_SIDECAR_URL or PLEXO_SERVICE_KEY')
        return 2
    }

    const rows = await loadAll()
    console.log(`postgres workspace_members count: ${rows.length}`)
    if (DRY_RUN) {
        console.log('--dry-run set; exiting without writing to graph.')
        return 0
    }

    const client = new GraphitiClient({
        baseUrl,
        serviceKey,
        appId: 'plexo-permissions-seed',
    })

    let written = 0
    let failedBatches = 0
    for (let i = 0; i < rows.length; i += BATCH) {
        const slice = rows.slice(i, i + BATCH)
        const ok = await seedBatch(client, slice)
        if (ok) {
            written += slice.length
            console.log(`  batch ${Math.floor(i / BATCH) + 1}: wrote ${slice.length} (cumulative ${written}/${rows.length})`)
        } else {
            failedBatches++
            console.error(`  batch ${Math.floor(i / BATCH) + 1}: FAILED (will retry on next run)`)
        }
        if (DELAY_MS > 0 && i + BATCH < rows.length) {
            await new Promise((r) => setTimeout(r, DELAY_MS))
        }
    }
    console.log(`\nDone. Wrote ${written}/${rows.length} memberships. Failed batches: ${failedBatches}.`)
    return failedBatches === 0 ? 0 : 1
}

main().then((code) => process.exit(code), (err) => {
    console.error('fatal:', err)
    process.exit(2)
})
