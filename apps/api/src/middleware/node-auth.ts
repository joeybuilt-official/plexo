// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Federation Node Auth Middleware
 *
 * Validates inbound federation requests from remote nodes using
 * per-node sync tokens. Remote nodes must include:
 *   X-Node-Did: did:plexo:<uuid>
 *   Authorization: Bearer <sync_token>
 *
 * The token is matched against nodes.sync_token for the identified node.
 * Rejected if the node is unknown, pending, or revoked.
 */

import type { Request, Response, NextFunction } from 'express'
import { timingSafeEqual } from 'crypto'
import { db, eq } from '@plexo/db'
import { nodes } from '@plexo/db'
import { logger } from '../logger.js'

export interface FederationNode {
    id: string
    did: string
    displayName: string | null
    status: string
}

declare global {
    namespace Express {
        interface Request {
            federationNode?: FederationNode
        }
    }
}

export async function requireNodeAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const did = req.headers['x-node-did'] as string | undefined
    if (!did) {
        res.status(401).json({ error: { code: 'MISSING_NODE_DID', message: 'X-Node-Did header required' } })
        return
    }

    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: { code: 'MISSING_TOKEN', message: 'Authorization: Bearer <sync_token> required' } })
        return
    }

    const token = authHeader.slice(7)

    try {
        const [node] = await db
            .select({ id: nodes.id, did: nodes.did, displayName: nodes.displayName, status: nodes.status, syncToken: nodes.syncToken })
            .from(nodes)
            .where(eq(nodes.did, did))
            .limit(1)

        if (!node) {
            res.status(403).json({ error: { code: 'UNKNOWN_NODE', message: 'Node not recognised — initiate pairing first' } })
            return
        }

        if (node.status === 'pending') {
            res.status(403).json({ error: { code: 'NODE_PENDING', message: 'Node is awaiting trust approval' } })
            return
        }

        if (node.status === 'revoked') {
            res.status(403).json({ error: { code: 'NODE_REVOKED', message: 'Node trust has been revoked' } })
            return
        }

        if (!node.syncToken) {
            res.status(403).json({ error: { code: 'NO_SYNC_TOKEN', message: 'Node has no sync token — re-pair to establish one' } })
            return
        }

        // Constant-time comparison
        const bufA = Buffer.from(token, 'utf-8')
        const bufB = Buffer.from(node.syncToken, 'utf-8')
        if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
            logger.warn({ did }, 'Federation auth: invalid sync token')
            res.status(403).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid sync token' } })
            return
        }

        req.federationNode = { id: node.id, did: node.did, displayName: node.displayName, status: node.status }
        next()
    } catch (err) {
        logger.error({ err }, 'requireNodeAuth: DB error')
        res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Auth check failed' } })
    }
}
