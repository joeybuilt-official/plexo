// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Federation Runtime API
 *
 * POST /api/v1/federation/pair              — Accept inbound pairing from a remote node
 * POST /api/v1/federation/events            — Receive an event from a remote node
 * POST /api/v1/federation/memory/push       — Receive a memory entry from a trusted node
 * POST /api/v1/federation/agent/route       — Route an agent task from a trusted node
 *
 * /pair is unauthenticated (creates a pending node, trust requires admin approval).
 * All other endpoints use per-node sync token auth via requireNodeAuth.
 */

import { Router, type Router as RouterType } from 'express'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { logger } from '../logger.js'
import { requireNodeAuth } from '../middleware/node-auth.js'
import * as nodesRepo from '../repositories/nodes.repository.js'

export const federationRouter: RouterType = Router()

// ── Trust scope helper ────────────────────────────────────────────────────────

async function hasTrustScope(remoteNodeId: string, scope: 'memorySync' | 'agentRouting' | 'eventPropagation') {
    const selfId = await nodesRepo.getSelfNodeId()
    if (!selfId) return false

    const edge = await nodesRepo.getTrustEdge(selfId, remoteNodeId)
    if (!edge || edge.revokedAt) return false
    return edge[scope] === true
}

// ── POST /pair — accept inbound pairing (unauthenticated) ────────────────────

const inboundPairSchema = z.object({
    did: z.string().min(1),
    displayName: z.string().min(1).optional(),
    url: z.string().url().optional(),
})

federationRouter.post('/pair', async (req, res) => {
    try {
        const parsed = inboundPairSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { did, displayName, url } = parsed.data

        const self = await nodesRepo.getSelfNode()
        if (!self) {
            return res.status(500).json({ error: { code: 'NO_SELF_NODE', message: 'Self-node not initialised' } })
        }

        // Generate a sync token the remote node will use for subsequent requests
        const syncToken = randomBytes(32).toString('hex')

        // Register the remote node as pending — local admin must approve trust
        await nodesRepo.upsertPendingNode({ did, displayName: displayName ?? null, url: url ?? null, syncToken })

        logger.info({ event: 'federation_pair_inbound', did }, 'Inbound pairing request received')

        return res.json({
            ok: true,
            selfDid: self.did,
            syncToken,
            message: 'Pairing request received. Configure this syncToken on your node, then await trust approval from the local administrator.',
        })
    } catch (err) {
        logger.error({ err }, 'POST /api/v1/federation/pair failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Pairing failed' } })
    }
})

// ── POST /events — receive an event from a federated node ────────────────────

const federatedEventSchema = z.object({
    eventType: z.string().min(1),
    payload: z.record(z.unknown()).default({}),
    workspaceId: z.string().uuid().optional(),
})

federationRouter.post('/events', requireNodeAuth, async (req, res) => {
    try {
        const parsed = federatedEventSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { eventType, payload, workspaceId } = parsed.data
        const remote = req.federationNode!

        const trusted = await hasTrustScope(remote.id, 'eventPropagation')
        if (!trusted) {
            return res.status(403).json({ error: { code: 'SCOPE_DENIED', message: 'Event propagation not trusted for this node' } })
        }

        await nodesRepo.insertNodeEvent({
            sourceNodeDid: remote.did,
            eventType,
            payload,
            workspaceId: workspaceId ?? null,
            processed: false,
        })

        await nodesRepo.touchNodeLastPing(remote.id)

        logger.info({ event: 'federation_event_received', sourceDid: remote.did, eventType }, 'Federated event stored')
        return res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'POST /api/v1/federation/events failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to store event' } })
    }
})

// ── POST /memory/push — receive a memory entry from a trusted node ───────────

const memoryPushSchema = z.object({
    workspaceId: z.string().uuid(),
    content: z.string().min(1),
    type: z.string().min(1).default('note'),
    tags: z.array(z.string()).default([]),
    metadata: z.record(z.unknown()).default({}),
})

federationRouter.post('/memory/push', requireNodeAuth, async (req, res) => {
    try {
        const parsed = memoryPushSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { workspaceId, content, type, tags, metadata } = parsed.data
        const remote = req.federationNode!

        const trusted = await hasTrustScope(remote.id, 'memorySync')
        if (!trusted) {
            return res.status(403).json({ error: { code: 'SCOPE_DENIED', message: 'Memory sync not trusted for this node' } })
        }

        await nodesRepo.insertNodeEvent({
            sourceNodeDid: remote.did,
            eventType: 'memory.push',
            payload: { workspaceId, content, type, tags, metadata },
            workspaceId,
            processed: false,
        })

        await nodesRepo.touchNodeLastPing(remote.id)

        logger.info({ event: 'federation_memory_push', sourceDid: remote.did, workspaceId }, 'Federated memory push received')
        return res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'POST /api/v1/federation/memory/push failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to process memory push' } })
    }
})

// ── POST /agent/route — route an agent task from a trusted node ───────────────

const agentRouteSchema = z.object({
    workspaceId: z.string().uuid(),
    prompt: z.string().min(1),
    context: z.record(z.unknown()).default({}),
    callbackUrl: z.string().url().optional(),
})

federationRouter.post('/agent/route', requireNodeAuth, async (req, res) => {
    try {
        const parsed = agentRouteSchema.safeParse(req.body)
        if (!parsed.success) {
            return res.status(400).json({
                error: {
                    code: 'VALIDATION_ERROR',
                    message: 'Invalid request body',
                    details: parsed.error.flatten().fieldErrors,
                },
            })
        }

        const { workspaceId, prompt, context, callbackUrl } = parsed.data
        const remote = req.federationNode!

        const trusted = await hasTrustScope(remote.id, 'agentRouting')
        if (!trusted) {
            return res.status(403).json({ error: { code: 'SCOPE_DENIED', message: 'Agent routing not trusted for this node' } })
        }

        const event = await nodesRepo.insertNodeEvent({
            sourceNodeDid: remote.did,
            eventType: 'agent.route',
            payload: { workspaceId, prompt, context, callbackUrl },
            workspaceId,
            processed: false,
        })

        await nodesRepo.touchNodeLastPing(remote.id)

        logger.info({ event: 'federation_agent_route', sourceDid: remote.did, workspaceId }, 'Federated agent route received')
        return res.json({ ok: true, eventId: event?.id })
    } catch (err) {
        logger.error({ err }, 'POST /api/v1/federation/agent/route failed')
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to route agent task' } })
    }
})
