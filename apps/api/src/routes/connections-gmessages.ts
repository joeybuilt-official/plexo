// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pairing lifecycle endpoints for Google Messages (ADR-0005).
 *
 * Mounted at /api/v1/connections/gmessages. Better Auth-gated via
 * ensureWorkspaceAccess. These are pairing-lifecycle endpoints — distinct
 * from /api/plexo/channels/gmessages/* which is the connector-facing
 * inbound contract (Phase 2). The split mirrors ADR-0005 §"Consequences":
 * pairing endpoints live under /api/connections/, NOT the subscription
 * contract.
 *
 * Flow per ADR-0005:
 *   1. UI POSTs /pair-start { workspaceId } → we ask the sidecar for a QR
 *      URL + pairing ID, return them. The sidecar holds the in-flight
 *      libgm.Client in its pair pool.
 *   2. UI polls /pair-status?id=X every 2s. We forward to the sidecar.
 *   3. On state=linked the sidecar returns a base64 AuthData blob; we
 *      encrypt via crypto-util.ts AES-256-GCM, persist as
 *      installed_connections.credentials, create the channels row,
 *      seed plexo_gmessages.paired_sessions, and tell the sidecar to
 *      discard the pair entry.
 *
 * Phase 4a ships the pair flow only. Phase 4b lands session.Manager.Start
 * to actually run the long-lived session from the encrypted blob.
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { eq, and } from 'drizzle-orm'
import * as connectionsGmessagesRepo from '../repositories/connections-gmessages.repository.js'
import { encrypt } from '../crypto.js'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { audit } from '../audit.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import {
    sidecarPairStart,
    sidecarPairStatus,
    sidecarPairDiscard,
} from '../lib/gmessages-sidecar.js'

export const connectionsGmessagesRouter: RouterType = Router()

const REGISTRY_ID = 'gmessages'

connectionsGmessagesRouter.post('/pair-start', async (req: Request, res: Response) => {
    const { workspaceId } = (req.body ?? {}) as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const sc = await sidecarPairStart()
        audit(req, {
            workspaceId,
            userId: req.user?.id,
            action: 'gmessages.pair.started',
            resource: 'paired_sessions',
            metadata: { pairingId: sc.pairingId },
        })
        trackEvent('gmessages.pair.started', 'info', { workspaceId, pairingId: sc.pairingId })
        res.status(200).json(sc)
    } catch (err) {
        logger.error({ err, workspaceId }, 'gmessages pair-start failed')
        res.status(502).json({ error: { code: 'SIDECAR_UNAVAILABLE', message: 'pairing service unavailable' } })
    }
})

connectionsGmessagesRouter.get('/pair-status', async (req: Request, res: Response) => {
    const workspaceId = req.query.workspaceId as string | undefined
    const pairingId = req.query.id as string | undefined
    if (!workspaceId || !UUID_RE.test(workspaceId) || !pairingId) {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'workspaceId + id required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const status = await sidecarPairStatus(pairingId)

        if (status.state !== 'linked') {
            res.status(200).json({ state: status.state, errorDetail: status.errorDetail, expiresAt: status.expiresAt })
            return
        }

        if (!status.authBlob) {
            res.status(502).json({ error: { code: 'SIDECAR_PROTOCOL', message: 'linked without authBlob' } })
            return
        }

        const result = await persistPairedConnection({
            req,
            workspaceId,
            authBlob: status.authBlob,
            actorUserId: req.user?.id,
        })

        // Best-effort sidecar cleanup; persistence already committed.
        sidecarPairDiscard(pairingId).catch(err => {
            logger.warn({ err, pairingId }, 'sidecar discard failed (non-fatal)')
        })

        res.status(200).json({
            state: 'linked',
            connectionId: result.installedConnectionId,
            channelId: result.channelId,
            pairedSessionId: result.pairedSessionId,
        })
    } catch (err) {
        logger.error({ err, workspaceId, pairingId }, 'gmessages pair-status failed')
        res.status(502).json({ error: { code: 'SIDECAR_UNAVAILABLE', message: 'pairing service unavailable' } })
    }
})

interface PersistArgs {
    req: Request
    workspaceId: string
    authBlob: string  // base64 JSON of libgm AuthData
    actorUserId?: string
}

interface PersistResult {
    installedConnectionId: string
    channelId: string
    pairedSessionId: string
}

async function persistPairedConnection(args: PersistArgs): Promise<PersistResult> {
    const { req, workspaceId, authBlob, actorUserId } = args

    // The sidecar gives us base64 of JSON-marshaled AuthData. We persist the
    // base64 string as-is inside the encrypted envelope — sidecar will
    // base64-decode + JSON.unmarshal on restore.
    const encryptedCreds = { encrypted: encrypt(authBlob, workspaceId) }

    const result = await connectionsGmessagesRepo.insertPairedConnection({
        workspaceId,
        registryId: REGISTRY_ID,
        encryptedCreds,
    })

    audit(req, {
        workspaceId,
        userId: actorUserId,
        action: 'gmessages.pair.linked',
        resource: 'paired_sessions',
        resourceId: result.pairedSessionId,
        metadata: {
            installedConnectionId: result.installedConnectionId,
            channelId: result.channelId,
        },
    })
    trackEvent('gmessages.pair.linked', 'info', { workspaceId })

    return result
}

// Suppress unused-import warning for `and`/`eq` until Phase 4b adds endpoints
// that filter on (workspaceId, registryId).
void and
void eq
