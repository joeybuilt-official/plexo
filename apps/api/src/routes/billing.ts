// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Billing routes — Stripe subscription management for Plexo SaaS users.
 *
 * Endpoints:
 *   GET  /api/v1/billing/subscription   — read current tier/status for the session user
 *   POST /api/v1/billing/checkout       — create a Stripe Checkout Session, returns { url }
 *   POST /api/v1/billing/stripe-webhook — Stripe → us: subscription lifecycle updates
 *
 * This is the controller ring: it parses requests, calls the injected billing
 * use-cases (wired by the composition factory in application/billing), and
 * formats responses. All business logic lives in the domain/application layers;
 * all drizzle/stripe access lives in the adapters.
 *
 * Notes:
 *   - Subscription state lives in `user_subscriptions` (slot 0071). We never
 *     store anything on the `users` table — that's a foreign table (FDW) and
 *     writes are forbidden by contract.
 *   - The webhook signature is verified with STRIPE_WEBHOOK_SECRET. Raw body
 *     parsing is handled by the mount in apps/api/src/index.ts — this router
 *     assumes req.body is a Buffer for the webhook path.
 *   - Stripe SDK is loaded lazily so a missing install/key doesn't crash
 *     boot; affected endpoints return 503 with a clear error instead.
 */

import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express'
import { makeBillingModule } from '../application/billing/index.js'
import { logger } from '../logger.js'
import { requireAuth } from '../middleware/auth.js'

export const billingRouter: RouterType = Router()

const billing = makeBillingModule()

// ── GET /subscription — read the caller's subscription ───────────────────────

billingRouter.get('/subscription', requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } })
        return
    }
    try {
        const sub = await billing.getSubscription(userId)
        res.json({
            subscription: {
                tier: sub.tier,
                status: sub.status,
                currentPeriodEnd: sub.currentPeriodEnd,
                trialEndsAt: sub.trialEndsAt,
            },
        })
    } catch (err) {
        logger.error({ err, userId }, '[billing] GET /subscription failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load subscription' } })
    }
})

// ── POST /checkout — start a Stripe Checkout Session ─────────────────────────

billingRouter.post('/checkout', requireAuth, async (req, res) => {
    const userId = req.user?.id
    const email = req.user?.email
    if (!userId || !email) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } })
        return
    }

    const gw = await billing.loadGateway()
    if (!gw) {
        res.status(503).json({
            error: { code: 'STRIPE_UNAVAILABLE', message: 'Billing is not configured on this instance.' },
        })
        return
    }

    const { priceId } = (req.body ?? {}) as { priceId?: string }
    if (!priceId || typeof priceId !== 'string') {
        res.status(400).json({ error: { code: 'MISSING_PRICE_ID', message: 'priceId required' } })
        return
    }

    try {
        const successUrl = (process.env.BILLING_SUCCESS_URL ?? 'https://app.example.com/app/account/subscription?checkout=success')
        const cancelUrl = (process.env.BILLING_CANCEL_URL ?? 'https://app.example.com/app/account/subscription?checkout=canceled')

        const result = await gw.createCheckout({ userId, email, priceId, successUrl, cancelUrl })

        res.json({ url: result.url, sessionId: result.sessionId })
    } catch (err) {
        logger.error({ err, userId }, '[billing] POST /checkout failed')
        res.status(500).json({ error: { code: 'CHECKOUT_FAILED', message: 'Could not start checkout' } })
    }
})

// ── POST /stripe-webhook — Stripe → us ───────────────────────────────────────
// NOTE: this handler expects req.body to be a raw Buffer. It is mounted
// directly at apps/api/src/index.ts with express.raw({ type: 'application/json' })
// so the signature check can succeed. Do NOT mount it through the billingRouter
// (which sits behind express.json()) or signature verification will break.

export const stripeWebhookHandler: RequestHandler = async (req: Request, res: Response) => {
    const gw = await billing.loadGateway()
    if (!gw) {
        res.status(503).send('stripe not configured')
        return
    }
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    if (!webhookSecret) {
        res.status(503).send('STRIPE_WEBHOOK_SECRET not configured')
        return
    }

    const sig = req.headers['stripe-signature']
    if (!sig || typeof sig !== 'string') {
        res.status(400).send('missing signature header')
        return
    }

    let event
    try {
        // req.body is a Buffer thanks to the raw parser mount.
        event = gw.gateway.constructWebhookEvent(req.body as Buffer, sig, webhookSecret)
    } catch (err) {
        logger.warn({ err }, '[billing] webhook signature verification failed')
        res.status(400).send('invalid signature')
        return
    }

    try {
        await billing.handleStripeWebhook(event)
        res.json({ received: true })
    } catch (err) {
        logger.error({ err, type: event.type }, '[billing] webhook handling failed')
        res.status(500).send('webhook handling failed')
    }
}
