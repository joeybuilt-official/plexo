// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Generic Webhook Trigger
 *
 * POST /api/v1/webhooks/:workspaceId — accepts JSON payload, creates a task.
 * Optional HMAC-SHA256 signature verification via X-Plexo-Signature header.
 */
import { Router, type Router as RouterType } from 'express'
import * as workspacesRepo from '../repositories/workspaces.repository.js'
import { push } from '@plexo/queue'
import { logger } from '../logger.js'
import * as crypto from 'crypto'
import { timingSafeEqual } from 'crypto'

export const webhooksRouter: RouterType = Router()

// ── POST /api/v1/webhooks/:workspaceId ──────────────────────────────────────

webhooksRouter.post('/:workspaceId', async (req, res) => {
    const { workspaceId } = req.params

    // Verify workspace exists
    try {
        const ws = await workspacesRepo.getIdById(workspaceId)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }
    } catch (err) {
        logger.error({ err, workspaceId }, 'POST /webhooks/:workspaceId workspace lookup failed')
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid workspace ID' } })
        return
    }

    // HMAC signature verification — required when secret is configured.
    //
    // NOTE: The HMAC is computed on JSON.stringify(req.body) — the re-serialized
    // JSON, NOT the raw request bytes. This means both the sender and receiver
    // must use the same JSON serialization (no extra whitespace, same key order).
    // Since Plexo controls both sides (sender in event-relay / CC, receiver here),
    // this is acceptable. External senders MUST compute HMAC on the compact
    // JSON.stringify() output to match. A raw-body approach (like the Stripe
    // webhook handler) would be more robust but requires a separate Express
    // mount point with express.raw() before the JSON body parser runs.
    const signature = req.headers['x-plexo-signature'] as string | undefined
    const webhookSecret = process.env.PLEXO_WEBHOOK_SECRET
    if (webhookSecret) {
        if (!signature) {
            res.status(401).json({ error: { code: 'MISSING_SIGNATURE', message: 'Missing X-Plexo-Signature header' } })
            return
        }
        const expected = 'sha256=' + crypto
            .createHmac('sha256', webhookSecret)
            .update(JSON.stringify(req.body))
            .digest('hex')
        const sigBuf = Buffer.from(signature)
        const expBuf = Buffer.from(expected)
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
            res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } })
            return
        }
    }

    const body = req.body as Record<string, unknown>
    const description = (body.description as string)
        ?? (body.message as string)
        ?? (body.text as string)
        ?? 'Webhook-triggered task'

    const taskType = (body.type as string) ?? 'general'

    try {
        const taskId = await push({
            workspaceId,
            type: 'general',
            source: 'webhook',
            context: {
                description,
                taskType,
                webhookPayload: body,
                webhookSource: req.headers['user-agent'] ?? 'unknown',
            },
        })

        logger.info({ taskId, workspaceId, source: 'webhook' }, 'Webhook task created')
        res.status(201).json({ taskId, status: 'queued' })
    } catch (err) {
        logger.error({ err }, 'POST /webhooks/:workspaceId failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create task' } })
    }
})
