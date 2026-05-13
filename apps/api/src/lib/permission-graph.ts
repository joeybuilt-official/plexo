// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import pino from 'pino'
import { GraphitiClient } from '@plexo/graphiti-bridge'

/**
 * Phase C1 (ADR 0022) — plexo workspace permission graph.
 *
 * Mirrors every workspace_members mutation as a MEMBER_OF edge in the
 * shared `plexo-permissions` graph. Edge property `role` carries the
 * postgres workspaceMembers.role value. Permission graph lives in a
 * single named graph (not per-workspace) because a user's memberships
 * span workspaces and the canonical query
 *   MATCH (u:User {id: $uid})-[r:MEMBER_OF]->(w:Workspace) RETURN w, r.role
 * needs cross-workspace traversal.
 *
 * ⚠ Security-critical (ADR 0016 Failure-C). This module is shadow-WRITE
 * only — postgres remains the source of truth. The middleware read path
 * still uses postgres + the in-process TTL cache. After ≥30 consecutive
 * days of zero diff between postgres and FalkorDB tuples (operator-run
 * reconciliation cron), the read path may flip per ADR 0022.
 *
 * Failure mode is no-op: env missing or sidecar unreachable → helpers
 * silently swallow; postgres write completes regardless.
 */

const PERMISSION_GRAPH_NAME = 'plexo-permissions'
const APP_ID = 'plexo-permissions'

const logger = pino({ name: 'permission-graph' })

let _client: GraphitiClient | null = null
let _clientWarned = false

function getClient(): GraphitiClient | null {
    if (_client) return _client
    const baseUrl = process.env.PLEXO_GRAPHITI_SIDECAR_URL
    const serviceKey = process.env.PLEXO_SERVICE_KEY
    if (!baseUrl || !serviceKey) {
        if (!_clientWarned) {
            logger.warn(
                { hasBaseUrl: !!baseUrl, hasServiceKey: !!serviceKey },
                'graphiti bridge not configured; permission graph dual-write disabled',
            )
            _clientWarned = true
        }
        return null
    }
    _client = new GraphitiClient({ baseUrl, serviceKey, appId: APP_ID })
    return _client
}

/** Test hook — drops the cached client. */
export function resetPermissionGraphForTest(): void {
    _client = null
    _clientWarned = false
}

/** Test hook — inject a custom client (e.g. a mock). */
export function setPermissionGraphClientForTest(client: GraphitiClient | null): void {
    _client = client
    _clientWarned = client !== null
}

export interface MirrorMembershipArgs {
    userId: string
    workspaceId: string
    /** workspace_members.role value. */
    role: string
}

/**
 * Fire-and-forget upsert of (User)-[:MEMBER_OF {role}]->(Workspace).
 * Idempotent on retry — MERGE clauses match by id and SET the role.
 */
export async function mirrorMembershipUpsert(args: MirrorMembershipArgs): Promise<void> {
    const client = getClient()
    if (!client) return
    try {
        await client.cypher({
            workspaceId: PERMISSION_GRAPH_NAME,
            cypher: `
                MERGE (u:User {id: $userId})
                MERGE (w:Workspace {id: $workspaceId})
                MERGE (u)-[r:MEMBER_OF]->(w)
                SET r.role = $role
            `,
            params: { userId: args.userId, workspaceId: args.workspaceId, role: args.role },
        })
    } catch (err) {
        logger.warn({ err, ...args }, 'permission-graph upsert failed')
    }
}

/**
 * Fire-and-forget delete of the MEMBER_OF edge. User + Workspace nodes
 * are left in place — other memberships may reference them.
 */
export async function mirrorMembershipDelete(args: {
    userId: string
    workspaceId: string
}): Promise<void> {
    const client = getClient()
    if (!client) return
    try {
        await client.cypher({
            workspaceId: PERMISSION_GRAPH_NAME,
            cypher: `
                MATCH (u:User {id: $userId})-[r:MEMBER_OF]->(w:Workspace {id: $workspaceId})
                DELETE r
            `,
            params: { userId: args.userId, workspaceId: args.workspaceId },
        })
    } catch (err) {
        logger.warn({ err, ...args }, 'permission-graph delete failed')
    }
}
