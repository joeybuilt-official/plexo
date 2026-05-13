#!/usr/bin/env tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase C1 (ADR 0022) — daily reconciliation between postgres
 * workspace_members and FalkorDB (User)-[:MEMBER_OF {role}]->(Workspace)
 * edges in the shared `plexo-permissions` graph.
 *
 * Purpose
 *   The 30-day dual-read window mandated by ADR 0016 Failure-C only has
 *   meaning if every (user, workspace, role) tuple in postgres matches a
 *   corresponding edge in FalkorDB on every day. This script runs as the
 *   day-counter — it must be in cron and producing zero-diff exits for
 *   30 consecutive days before any read-path cutover.
 *
 * Output (stdout JSON line — easy to grep + alert on):
 *   {
 *     "timestamp": "...",
 *     "postgres_count": N,
 *     "graph_count": M,
 *     "matched": K,
 *     "postgres_only": [{ userId, workspaceId, role }, ...],
 *     "graph_only":    [{ userId, workspaceId, role }, ...],
 *     "role_mismatch": [{ userId, workspaceId, pgRole, graphRole }, ...]
 *   }
 *
 * Exit code
 *   0 — counts equal, zero diff. Cron treats this as a clean day.
 *   1 — any diff. Cron writes a sentinel file or pages oncall.
 *   2 — sidecar unreachable / setup error (NOT counted as a clean day).
 *
 * Usage:
 *   PLEXO_GRAPHITI_SIDECAR_URL=http://127.0.0.1:8090 \
 *   PLEXO_SERVICE_KEY=<...> \
 *   DATABASE_URL=postgres://... \
 *   pnpm tsx scripts/reconcile-permission-graph.ts
 *
 *   Add `--verbose` to dump every diff entry rather than just the counts.
 */

import { db } from '@plexo/db'
import { workspaceMembers } from '@plexo/db'
import { GraphitiClient } from '@plexo/graphiti-bridge'

const VERBOSE = process.argv.includes('--verbose')
const PERMISSION_GRAPH_NAME = 'plexo-permissions'

interface Tuple {
    userId: string
    workspaceId: string
    role: string
}

function key(t: { userId: string; workspaceId: string }): string {
    return `${t.userId}|${t.workspaceId}`
}

async function loadPostgresTuples(): Promise<Tuple[]> {
    const rows = await db
        .select({
            userId: workspaceMembers.userId,
            workspaceId: workspaceMembers.workspaceId,
            role: workspaceMembers.role,
        })
        .from(workspaceMembers)
    return rows.map((r) => ({ userId: r.userId, workspaceId: r.workspaceId, role: r.role }))
}

async function loadGraphTuples(client: GraphitiClient): Promise<Tuple[]> {
    const result = await client.cypher({
        workspaceId: PERMISSION_GRAPH_NAME,
        cypher: `
            MATCH (u:User)-[r:MEMBER_OF]->(w:Workspace)
            RETURN u.id AS userId, w.id AS workspaceId, r.role AS role
        `,
        params: {},
    })
    if (!result) throw new Error('sidecar /v1/graph/cypher returned null')
    return result.rows.map((row) => {
        const [userId, workspaceId, role] = row as [string, string, string]
        return { userId, workspaceId, role }
    })
}

function diff(pg: Tuple[], graph: Tuple[]) {
    const pgMap = new Map(pg.map((t) => [key(t), t]))
    const graphMap = new Map(graph.map((t) => [key(t), t]))
    const postgresOnly: Tuple[] = []
    const graphOnly: Tuple[] = []
    const roleMismatch: Array<{ userId: string; workspaceId: string; pgRole: string; graphRole: string }> = []
    let matched = 0
    for (const [k, pgRow] of pgMap) {
        const gRow = graphMap.get(k)
        if (!gRow) postgresOnly.push(pgRow)
        else if (gRow.role !== pgRow.role) {
            roleMismatch.push({
                userId: pgRow.userId,
                workspaceId: pgRow.workspaceId,
                pgRole: pgRow.role,
                graphRole: gRow.role,
            })
        } else matched++
    }
    for (const [k, gRow] of graphMap) {
        if (!pgMap.has(k)) graphOnly.push(gRow)
    }
    return { matched, postgresOnly, graphOnly, roleMismatch }
}

async function main(): Promise<number> {
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) {
        console.error(
            JSON.stringify({
                timestamp: new Date().toISOString(),
                error: 'missing env: PLEXO_GRAPHITI_SIDECAR_URL or PLEXO_SERVICE_KEY',
            }),
        )
        return 2
    }
    const client = new GraphitiClient({
        baseUrl,
        serviceKey,
        appId: 'plexo-permissions-reconcile',
    })
    let pg: Tuple[]
    let graph: Tuple[]
    try {
        ;[pg, graph] = await Promise.all([loadPostgresTuples(), loadGraphTuples(client)])
    } catch (err) {
        console.error(JSON.stringify({ timestamp: new Date().toISOString(), error: String(err) }))
        return 2
    }

    const d = diff(pg, graph)
    const isClean =
        d.postgresOnly.length === 0 && d.graphOnly.length === 0 && d.roleMismatch.length === 0
    const summary: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        postgres_count: pg.length,
        graph_count: graph.length,
        matched: d.matched,
        postgres_only_count: d.postgresOnly.length,
        graph_only_count: d.graphOnly.length,
        role_mismatch_count: d.roleMismatch.length,
        clean: isClean,
    }
    if (VERBOSE || !isClean) {
        summary.postgres_only = d.postgresOnly
        summary.graph_only = d.graphOnly
        summary.role_mismatch = d.roleMismatch
    }
    console.log(JSON.stringify(summary))
    return isClean ? 0 : 1
}

main().then((code) => process.exit(code), (err) => {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), fatal: String(err) }))
    process.exit(2)
})
