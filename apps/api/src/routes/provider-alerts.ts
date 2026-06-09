// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider-alert routes — site-wide notices about provider health (Fix A).
 *
 * GET  /api/v1/workspaces/:id/provider-alerts                  — balance-exhausted providers
 * POST /api/v1/workspaces/:id/provider-alerts/:provider/dismiss — clear + re-arm the provider
 *
 * Today this surfaces funds-depletion ("Insufficient Balance") state: when a
 * provider runs out of credit the router pulls it from the routing chain and
 * persists balance_exhausted_at. The web app polls this endpoint to render a
 * dismissible banner; dismissal clears the flag and re-arms the provider.
 */

import { Router } from 'express'
import pino from 'pino'

const logger = pino({ name: 'provider-alerts' })
const router: import('express').Router = Router({ mergeParams: true })

// GET /api/v1/workspaces/:id/provider-alerts
router.get('/', async (req: any, res: any) => {
    const workspaceId = req.params.id as string
    if (!workspaceId) return res.status(400).json({ error: 'workspace ID required' })
    try {
        const { listBalanceExhaustedProviders } = await import('@plexo/agent/providers/settings-from-instances')
        const balanceExhausted = await listBalanceExhaustedProviders(workspaceId)
        return res.json({ balanceExhausted })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to list provider alerts')
        return res.status(500).json({ error: 'Failed to load provider alerts' })
    }
})

// POST /api/v1/workspaces/:id/provider-alerts/:provider/dismiss
router.post('/:provider/dismiss', async (req: any, res: any) => {
    const workspaceId = req.params.id as string
    const provider = req.params.provider as string
    if (!workspaceId || !provider) return res.status(400).json({ error: 'workspace ID and provider required' })
    try {
        const { clearProviderBalanceExhausted } = await import('@plexo/agent/providers/settings-from-instances')
        await clearProviderBalanceExhausted(workspaceId, provider)
        logger.info({ workspaceId, provider }, 'provider balance-exhausted alert dismissed — re-armed')
        return res.json({ ok: true })
    } catch (err) {
        logger.error({ err, workspaceId, provider }, 'Failed to dismiss provider alert')
        return res.status(500).json({ error: 'Failed to dismiss alert' })
    }
})

export const providerAlertsRouter = router
