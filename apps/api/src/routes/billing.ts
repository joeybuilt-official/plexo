// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Billing routes — Stripe subscription management for Plexo SaaS users.
 *
 * Endpoints:
 *   GET  /api/v1/billing/subscription   — read current tier/status for the session user
 *   POST /api/v1/billing/checkout       — create a Stripe Checkout Session, returns { url }
 *   POST /api/v1/billing/stripe-webhook — Stripe → us: subscription lifecycle updates
 *
 * Notes:
 *   - Subscription state lives in `user_subscriptions` (slot 0071). We never
 *     store anything on the `users` table — that's a foreign table (FDW) and
 *     writes are forbidden by contract.
 *   - The webhook signature is verified with STRIPE_WEBHOOK_SECRET. Raw body
 *     parsing is handled by the mount in apps/api/src/index.ts — this router
 *     assumes req.body is a Buffer for the webhook path.
 *   - Stripe SDK is imported lazily so a missing install/key doesn't crash
 *     boot; affected endpoints return 503 with a clear error instead.
 */

import { Router, type Router as RouterType, type Request, type Response, type RequestHandler } from 'express'
import { db, eq, sql } from '@plexo/db'
import { userSubscriptions } from '@plexo/db'
import { logger } from '../logger.js'
import { requireAuth } from '../middleware/auth.js'

type StripeEvent = {
    type: string
    data: { object: Record<string, unknown> }
}

export const billingRouter: RouterType = Router()

// Lazy-loaded Stripe singleton. Kept out of module scope so the api process
// can start without STRIPE_SECRET_KEY set (for dev / self-host).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _stripe: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getStripe(): Promise<any | null> {
    if (_stripe) return _stripe
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) return null
    try {
        const mod = await import('stripe')
        const Stripe = (mod as unknown as { default: new (k: string, opts?: unknown) => unknown }).default
        _stripe = new Stripe(key, { apiVersion: '2024-12-18.acacia' as unknown as string })
        return _stripe
    } catch (err) {
        logger.warn({ err }, '[billing] stripe SDK not installed')
        return null
    }
}

async function getOrCreateSubscriptionRow(userId: string) {
    const existing = await db
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId))
        .limit(1)

    if (existing.length > 0) return existing[0]!

    const [row] = await db
        .insert(userSubscriptions)
        .values({ userId, tier: 'free', status: 'active' })
        .onConflictDoNothing()
        .returning()

    if (row) return row
    // Race — another request inserted first. Re-read.
    const [again] = await db
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId))
        .limit(1)
    return again!
}

// ── GET /subscription — read the caller's subscription ───────────────────────

billingRouter.get('/subscription', requireAuth, async (req, res) => {
    const userId = req.user?.id
    if (!userId) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Sign in required' } })
        return
    }
    try {
        const row = await getOrCreateSubscriptionRow(userId)
        res.json({
            subscription: {
                tier: row.tier,
                status: row.status,
                currentPeriodEnd: row.currentPeriodEnd,
                trialEndsAt: row.trialEndsAt,
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

    const stripe = await getStripe()
    if (!stripe) {
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
        const row = await getOrCreateSubscriptionRow(userId)

        // Reuse the Stripe customer if we already created one; otherwise let
        // Stripe create a new one and persist its id on webhook receipt.
        const successUrl = (process.env.BILLING_SUCCESS_URL ?? 'https://getplexo.com/app/account/subscription?checkout=success')
        const cancelUrl = (process.env.BILLING_CANCEL_URL ?? 'https://getplexo.com/app/account/subscription?checkout=canceled')

        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: successUrl,
            cancel_url: cancelUrl,
            customer_email: row.stripeCustomerId ? undefined : email,
            customer: row.stripeCustomerId ?? undefined,
            client_reference_id: userId,
            metadata: { plexoUserId: userId },
            subscription_data: { metadata: { plexoUserId: userId } },
            allow_promotion_codes: true,
        })

        res.json({ url: session.url, sessionId: session.id })
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
    const stripe = await getStripe()
    if (!stripe) {
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

    let event: StripeEvent
    try {
        // req.body is a Buffer thanks to the raw parser mount.
        event = stripe.webhooks.constructEvent(req.body as Buffer, sig, webhookSecret) as StripeEvent
    } catch (err) {
        logger.warn({ err }, '[billing] webhook signature verification failed')
        res.status(400).send('invalid signature')
        return
    }

    try {
        await handleWebhookEvent(event)
        res.json({ received: true })
    } catch (err) {
        logger.error({ err, type: event.type }, '[billing] webhook handling failed')
        res.status(500).send('webhook handling failed')
    }
}

async function handleWebhookEvent(event: StripeEvent): Promise<void> {
    const type = event.type as string

    switch (type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted': {
            const sub = event.data.object as {
                id: string
                customer: string
                status: string
                current_period_end?: number
                cancel_at?: number | null
                trial_end?: number | null
                metadata?: Record<string, string>
                items?: { data: Array<{ price?: { id: string; lookup_key?: string } }> }
            }

            const plexoUserId = sub.metadata?.plexoUserId
            if (!plexoUserId) {
                logger.warn({ subId: sub.id }, '[billing] webhook missing plexoUserId metadata')
                return
            }

            const tierFromPrice = resolveTierFromPrice(sub.items?.data?.[0]?.price)
            const tier = type === 'customer.subscription.deleted' ? 'free' : tierFromPrice
            const status = mapStripeStatus(sub.status)

            await db
                .insert(userSubscriptions)
                .values({
                    userId: plexoUserId,
                    tier,
                    status,
                    stripeCustomerId: sub.customer,
                    stripeSubscriptionId: sub.id,
                    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
                    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
                })
                .onConflictDoUpdate({
                    target: userSubscriptions.userId,
                    set: {
                        tier,
                        status,
                        stripeCustomerId: sub.customer,
                        stripeSubscriptionId: sub.id,
                        currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
                        trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
                        updatedAt: sql`now()`,
                    },
                })

            logger.info({ plexoUserId, tier, status, type }, '[billing] subscription updated')
            return
        }
        default:
            // Silently ignore unhandled event types — Stripe sends many, we
            // only care about subscription lifecycle for now.
            return
    }
}

function resolveTierFromPrice(price: { id?: string; lookup_key?: string } | undefined): 'free' | 'pro' | 'team' | 'enterprise' {
    if (!price) return 'free'
    const lookup = price.lookup_key ?? ''
    if (lookup.includes('enterprise')) return 'enterprise'
    if (lookup.includes('team')) return 'team'
    if (lookup.includes('pro')) return 'pro'
    // Fall back to env-pinned Pro id.
    if (process.env.STRIPE_PRICE_ID_PRO && price.id === process.env.STRIPE_PRICE_ID_PRO) return 'pro'
    if (process.env.STRIPE_PRICE_ID_TEAM && price.id === process.env.STRIPE_PRICE_ID_TEAM) return 'team'
    if (process.env.STRIPE_PRICE_ID_ENTERPRISE && price.id === process.env.STRIPE_PRICE_ID_ENTERPRISE) return 'enterprise'
    return 'pro'
}

function mapStripeStatus(stripeStatus: string): 'active' | 'past_due' | 'canceled' | 'paused' {
    switch (stripeStatus) {
        case 'active':
        case 'trialing':
            return 'active'
        case 'past_due':
        case 'unpaid':
            return 'past_due'
        case 'paused':
            return 'paused'
        case 'canceled':
        case 'incomplete_expired':
            return 'canceled'
        default:
            return 'active'
    }
}
