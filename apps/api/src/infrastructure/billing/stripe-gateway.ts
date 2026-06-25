// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stripe payment gateway adapter.
 *
 * Implements the `PaymentGateway` port over the Stripe SDK. This is the ONLY
 * layer permitted to import stripe. The SDK is loaded lazily so the api process
 * can start without STRIPE_SECRET_KEY set (dev / self-host); `load()` returns
 * null when unavailable and the controller maps that to a 503.
 */

import { logger } from '../../logger.js'
import type {
    CheckoutParams,
    CheckoutResult,
    PaymentGateway,
    StripeWebhookEvent,
} from '../../application/billing/ports.js'

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

export class StripePaymentGateway implements PaymentGateway {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(private readonly stripe: any) {}

    /**
     * Build a configured gateway, or null when Stripe is unavailable
     * (no key / SDK not installed). Lets the controller return a 503.
     */
    static async load(): Promise<StripePaymentGateway | null> {
        const stripe = await getStripe()
        return stripe ? new StripePaymentGateway(stripe) : null
    }

    async createCheckoutSession(params: CheckoutParams): Promise<CheckoutResult> {
        const session = await this.stripe.checkout.sessions.create({
            mode: 'subscription',
            line_items: [{ price: params.priceId, quantity: 1 }],
            success_url: params.successUrl,
            cancel_url: params.cancelUrl,
            customer_email: params.stripeCustomerId ? undefined : params.email,
            customer: params.stripeCustomerId ?? undefined,
            client_reference_id: params.userId,
            metadata: { plexoUserId: params.userId },
            subscription_data: { metadata: { plexoUserId: params.userId } },
            allow_promotion_codes: true,
        })
        return { url: session.url, sessionId: session.id }
    }

    constructWebhookEvent(rawBody: Buffer, signature: string, secret: string): StripeWebhookEvent {
        return this.stripe.webhooks.constructEvent(rawBody, signature, secret) as StripeWebhookEvent
    }
}
