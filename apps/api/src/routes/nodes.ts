// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Federation Node Management API
 *
 * GET  /api/v1/nodes          — List known nodes
 * GET  /api/v1/nodes/self     — Get this instance's self-node
 * POST /api/v1/nodes/pair     — Initiate pairing with a remote node
 * PATCH /api/v1/nodes/:id/trust — Update trust scopes for a node
 * DELETE /api/v1/nodes/:id    — Remove a node and its trust edges
 */

import { Router, type Router as RouterType } from 'express'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { db, eq, and } from '@plexo/db'
import { nodes, nodeTrust } from '@plexo/db'
import { logger } from '../logger.js'
import { requireAuth } from '../middleware/auth.js'
import { requireSuperAdmin } from '../middleware/super-admin.js'
import { UUID_RE } from '../validation.js'

export const nodesRouter: RouterType = Router()

// All node management requires super-admin — federation is an instance-level concern
const guard = [requireAuth, requireSuperAdmin]

// ── GET / — list all known nodes ─────────────────────────────────────────────

nodesRouter.get('/', ...guard, async (_req, res) => {
    try {
        const [self] = await db
            .select({ id: nodes.id })
            .from(nodes)
            .where(eq(nodes.isSelf, true))
            .limit(1)

        const rows = await db
            .select({
                id: nodes.id,
                did: nodes.did,
                displayName: nodes.displayName,
                url: nodes.url,
                isSelf: nodes.isSelf,
                status: nodes.status,
                lastPingAt: nodes.lastPingAt,
                createdAt: nodes.createdAt,
            })
            .from(nodes)
            .orderBy(nodes.createdAt)

        // Attach trust edges (from self's perspective) for each remote node
        const trustEdges = self
            ? await db
                .select()
                .from(nodeTrust)
                .where(eq(nodeTrust.localNodeId, self.id))
            : []

        const trustByRemoteId = Object.fromEntries(trustEdges.map(e => [e.remoteNodeId, e]))

        const items = rows.map(node => ({
            ...node,
            trust: node.isSelf ? null : (trustByRemoteId[node.id] ?? null),
        }))

        return res.json({ items, total: items.length })
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/nodes failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list nodes' } })
    }
})

// ── GET /self — get this node's identity ─────────────────────────────────────

nodesRouter.get('/self', ...guard, async (_req, res) => {
    try {
        const [self] = await db
            .select()
            .from(nodes)
            .where(eq(nodes.isSelf, true))
            .limit(1)

        if (!self) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Self-node not initialised' } })
        }

        return res.json(self)
    } catch (err) {
        logger.error({ err }, 'GET /api/v1/nodes/self failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch self-node' } })
    }
})

// ── POST /pair — add a remote node and optionally set trust ──────────────────

const pairSchema = z.object({
    did: z.string().min(1),
    displayName: z.string().min(1).optional(),
    url: z.string().url().optional(),
    trust: z.object({
        memorySync: z.boolean().default(false),
        agentRouting: z.boolean().default(false),
        eventPropagation: z.boolean().default(false),
    }).optional(),
})

nodesRouter.post('/pair', ...guard, async (req, res) => {
    try {
        const parsed = pairSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { did, displayName, url, trust } = parsed.data

        // Generate a per-node sync token — the remote uses this to authenticate inbound requests
        const syncToken = randomBytes(32).toString('hex')

        // Get self-node id for trust edges
        const [self] = await db
            .select({ id: nodes.id })
            .from(nodes)
            .where(eq(nodes.isSelf, true))
            .limit(1)

        if (!self) {
            return res.status(500).json({ error: { code: 'NO_SELF_NODE', message: 'Self-node not initialised' } })
        }

        // Upsert the remote node with a fresh sync token
        const [remote] = await db
            .insert(nodes)
            .values({ did, displayName: displayName ?? null, url: url ?? null, isSelf: false, status: 'active', syncToken })
            .onConflictDoUpdate({
                target: nodes.did,
                set: {
                    displayName: displayName ?? null,
                    url: url ?? null,
                    status: 'active',
                    syncToken,
                },
            })
            .returning()

        // Upsert trust edge if requested
        if (trust && remote) {
            await db
                .insert(nodeTrust)
                .values({
                    localNodeId: self.id,
                    remoteNodeId: remote.id,
                    memorySync: trust.memorySync,
                    agentRouting: trust.agentRouting,
                    eventPropagation: trust.eventPropagation,
                })
                .onConflictDoUpdate({
                    target: [nodeTrust.localNodeId, nodeTrust.remoteNodeId],
                    set: {
                        memorySync: trust.memorySync,
                        agentRouting: trust.agentRouting,
                        eventPropagation: trust.eventPropagation,
                        revokedAt: null,
                    },
                })
        }

        if (!remote) {
            return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to upsert node' } })
        }

        logger.info({ event: 'node_paired', did }, 'Remote node paired')
        // Return syncToken in response — the remote admin must configure this on their node
        const { syncToken: _omit, ...nodePublic } = remote
        return res.json({ ok: true, node: nodePublic, syncToken })
    } catch (err) {
        logger.error({ err }, 'POST /api/v1/nodes/pair failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Pairing failed' } })
    }
})

// ── PATCH /:id/trust — update trust scopes ───────────────────────────────────

const trustPatchSchema = z.object({
    memorySync: z.boolean().optional(),
    agentRouting: z.boolean().optional(),
    eventPropagation: z.boolean().optional(),
    revoke: z.boolean().optional(),
})

nodesRouter.patch('/:id/trust', ...guard, async (req, res) => {
    const id = (req.params as { id: string }).id
    if (!UUID_RE.test(id)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'id must be a UUID' } })
    }

    try {
        const parsed = trustPatchSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { memorySync, agentRouting, eventPropagation, revoke } = parsed.data

        const [self] = await db
            .select({ id: nodes.id })
            .from(nodes)
            .where(eq(nodes.isSelf, true))
            .limit(1)

        if (!self) {
            return res.status(500).json({ error: { code: 'NO_SELF_NODE', message: 'Self-node not initialised' } })
        }

        if (memorySync === undefined && agentRouting === undefined && eventPropagation === undefined && revoke === undefined) {
            return res.status(400).json({ error: { code: 'NO_FIELDS', message: 'Nothing to update' } })
        }

        // Upsert: create the trust edge if it doesn't exist, then apply the patch
        const [upserted] = await db
            .insert(nodeTrust)
            .values({
                localNodeId: self.id,
                remoteNodeId: id,
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

        return res.json({ ok: true, trust: upserted })
    } catch (err) {
        logger.error({ err }, 'PATCH /api/v1/nodes/:id/trust failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update trust' } })
    }
})

// ── DELETE /:id — remove a node ───────────────────────────────────────────────

nodesRouter.delete('/:id', ...guard, async (req, res) => {
    const id = (req.params as { id: string }).id
    if (!UUID_RE.test(id)) {
        return res.status(400).json({ error: { code: 'INVALID_ID', message: 'id must be a UUID' } })
    }

    try {
        const [node] = await db.select({ isSelf: nodes.isSelf }).from(nodes).where(eq(nodes.id, id)).limit(1)

        if (!node) {
            return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Node not found' } })
        }

        if (node.isSelf) {
            return res.status(400).json({ error: { code: 'CANNOT_DELETE_SELF', message: 'Cannot delete the self-node' } })
        }

        await db.delete(nodes).where(eq(nodes.id, id))

        logger.info({ event: 'node_removed', nodeId: id }, 'Node removed')
        return res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE /api/v1/nodes/:id failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete node' } })
    }
})
