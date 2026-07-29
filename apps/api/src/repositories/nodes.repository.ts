// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Nodes data-access repository (federation aggregate).
 *
 * first repository boundary. This module is the single owner
 * of all `nodes` / `node_trust` persistence; route handlers (`routes/nodes.ts`)
 * call these functions and keep auth, validation, and response shaping. This is
 * the pattern to replicate per-aggregate so the ~82 route files stop importing
 * `db` directly — letting tenancy scoping, caching, and a future driver swap be
 * solved in one place per aggregate instead of scattered across controllers.
 *
 * No interface/port ceremony yet (single implementation, pragmatism clause) —
 * just centralised, typed queries.
 */
import { eq, and, desc, count } from 'drizzle-orm'
import { db } from '@plexo/db'
import { nodes, nodeTrust, nodeEvents } from '@plexo/db'

type Node = typeof nodes.$inferSelect
type NodeTrust = typeof nodeTrust.$inferSelect
type NodeEvent = typeof nodeEvents.$inferSelect
type NewNodeEvent = typeof nodeEvents.$inferInsert

export interface ListNodesOpts {
    limit: number
    offset: number
}

const NODE_LIST_COLUMNS = {
    id: nodes.id,
    did: nodes.did,
    displayName: nodes.displayName,
    url: nodes.url,
    isSelf: nodes.isSelf,
    status: nodes.status,
    lastPingAt: nodes.lastPingAt,
    createdAt: nodes.createdAt,
}

export type NodeListRow = {
    id: string
    did: string
    displayName: string | null
    url: string | null
    isSelf: boolean
    status: string
    lastPingAt: Date | null
    createdAt: Date
}

/** Paginated public node list, oldest first. */
export async function listNodes({ limit, offset }: ListNodesOpts): Promise<NodeListRow[]> {
    return db
        .select(NODE_LIST_COLUMNS)
        .from(nodes)
        .orderBy(nodes.createdAt)
        .limit(limit)
        .offset(offset) as Promise<NodeListRow[]>
}

/** Total node count (for pagination metadata). */
export async function countNodes(): Promise<number> {
    const [{ value } = { value: 0 }] = await db.select({ value: count() }).from(nodes)
    return value
}

/** Full self-node row, or undefined if not initialised. */
export async function getSelfNode(): Promise<Node | undefined> {
    const [self] = await db.select().from(nodes).where(eq(nodes.isSelf, true)).limit(1)
    return self
}

/** Self-node id only (hot path for trust-edge attach). */
export async function getSelfNodeId(): Promise<string | undefined> {
    const [self] = await db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isSelf, true)).limit(1)
    return self?.id
}

/** Trust edges from the local (self) node's perspective. */
export async function getTrustEdgesForLocal(localNodeId: string): Promise<NodeTrust[]> {
    return db.select().from(nodeTrust).where(eq(nodeTrust.localNodeId, localNodeId))
}

export interface UpsertRemoteNodeInput {
    did: string
    displayName: string | null
    url: string | null
    syncToken: string
}

/** Upsert a remote node by DID, refreshing its sync token. Returns the row. */
export async function upsertRemoteNode(input: UpsertRemoteNodeInput): Promise<Node | undefined> {
    const [remote] = await db
        .insert(nodes)
        .values({ ...input, isSelf: false, status: 'active' })
        .onConflictDoUpdate({
            target: nodes.did,
            set: {
                displayName: input.displayName,
                url: input.url,
                status: 'active',
                syncToken: input.syncToken,
            },
        })
        .returning()
    return remote
}

export interface TrustScopes {
    memorySync: boolean
    agentRouting: boolean
    eventPropagation: boolean
}

/** Pair-time trust upsert: set all scopes and clear any prior revocation. */
export async function upsertTrustFull(localNodeId: string, remoteNodeId: string, scopes: TrustScopes): Promise<void> {
    await db
        .insert(nodeTrust)
        .values({ localNodeId, remoteNodeId, ...scopes })
        .onConflictDoUpdate({
            target: [nodeTrust.localNodeId, nodeTrust.remoteNodeId],
            set: { ...scopes, revokedAt: null },
        })
}

export interface TrustPatch {
    memorySync?: boolean
    agentRouting?: boolean
    eventPropagation?: boolean
    revoke?: boolean
}

/** Partial trust patch: create the edge if missing, else apply only provided fields. */
export async function upsertTrustPatch(localNodeId: string, remoteNodeId: string, patch: TrustPatch): Promise<NodeTrust | undefined> {
    const { memorySync, agentRouting, eventPropagation, revoke } = patch
    const [upserted] = await db
        .insert(nodeTrust)
        .values({
            localNodeId,
            remoteNodeId,
            memorySync: memorySync ?? false,
            agentRouting: agentRouting ?? false,
            eventPropagation: eventPropagation ?? false,
            revokedAt: revoke === true ? new Date() : null,
        })
        .onConflictDoUpdate({
            target: [nodeTrust.localNodeId, nodeTrust.remoteNodeId],
            set: {
                ...(memorySync !== undefined && { memorySync }),
                ...(agentRouting !== undefined && { agentRouting }),
                ...(eventPropagation !== undefined && { eventPropagation }),
                ...(revoke === true && { revokedAt: new Date() }),
                ...(revoke === false && { revokedAt: null }),
            },
        })
        .returning()
    return upserted
}

/** Self-flag lookup for delete-guard. */
export async function getNodeIsSelf(id: string): Promise<{ isSelf: boolean } | undefined> {
    const [node] = await db.select({ isSelf: nodes.isSelf }).from(nodes).where(eq(nodes.id, id)).limit(1)
    return node
}

/** Delete a node by id (trust edges cascade at the DB level). */
export async function deleteNode(id: string): Promise<void> {
    await db.delete(nodes).where(eq(nodes.id, id))
}

// ── Federation runtime (events + trust checks + pairing) ──────────────────────

/** The trust edge between local and a remote node, or undefined. */
export async function getTrustEdge(localNodeId: string, remoteNodeId: string): Promise<NodeTrust | undefined> {
    const [edge] = await db
        .select()
        .from(nodeTrust)
        .where(and(eq(nodeTrust.localNodeId, localNodeId), eq(nodeTrust.remoteNodeId, remoteNodeId)))
        .limit(1)
    return edge
}

/** Register an inbound remote node as `pending` (admin must approve trust). */
export async function upsertPendingNode(input: { did: string; displayName: string | null; url: string | null; syncToken: string }): Promise<void> {
    await db
        .insert(nodes)
        .values({ ...input, isSelf: false, status: 'pending' })
        .onConflictDoUpdate({
            target: nodes.did,
            set: { displayName: input.displayName, url: input.url, syncToken: input.syncToken },
        })
}

/** Insert a node event; returns the created row. */
export async function insertNodeEvent(values: NewNodeEvent): Promise<NodeEvent | undefined> {
    const [event] = await db.insert(nodeEvents).values(values).returning()
    return event
}

/** Stamp a node's last-ping time (federation liveness). */
export async function touchNodeLastPing(nodeId: string): Promise<void> {
    await db.update(nodes).set({ lastPingAt: new Date() }).where(eq(nodes.id, nodeId))
}

export interface ListNodeEventsOpts {
    processed?: boolean
    limit: number
    offset: number
}

/** Recent node events, newest first, optionally filtered by processed state. */
export async function listNodeEvents({ processed, limit, offset }: ListNodeEventsOpts): Promise<NodeEvent[]> {
    return processed !== undefined
        ? db.select().from(nodeEvents).where(eq(nodeEvents.processed, processed)).orderBy(desc(nodeEvents.createdAt)).limit(limit).offset(offset)
        : db.select().from(nodeEvents).orderBy(desc(nodeEvents.createdAt)).limit(limit).offset(offset)
}

/** Mark a node event processed; returns the updated row (undefined if missing). */
export async function markNodeEventProcessed(id: string): Promise<NodeEvent | undefined> {
    const [updated] = await db.update(nodeEvents).set({ processed: true }).where(eq(nodeEvents.id, id)).returning()
    return updated
}
