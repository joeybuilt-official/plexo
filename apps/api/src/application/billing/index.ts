// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Billing composition root.
 *
 * Wires the concrete adapters (drizzle repo, stripe gateway) into the
 * use-cases. This is the one place allowed to know about both the application
 * ports and the infrastructure adapters; the controller depends only on what
 * this factory returns. Lightweight constructor/factory DI — no container.
 *
 * The Stripe gateway is loaded lazily (it may be unavailable → 503), so the
 * checkout/webhook use-cases are built on demand once a gateway is in hand.
 */

import { DrizzleSubscriptionRepository } from '../../repositories/billing.repository.js'
import { StripePaymentGateway } from '../../infrastructure/billing/stripe-gateway.js'
import type { PaymentGateway } from './ports.js'
import { makeGetSubscription } from './get-subscription.js'
import { makeCreateCheckout } from './create-checkout.js'
import { makeHandleStripeWebhook } from './handle-stripe-webhook.js'

export function makeBillingModule() {
    const repo = new DrizzleSubscriptionRepository()

    return {
        /** Get-or-create the caller's subscription (no Stripe needed). */
        getSubscription: makeGetSubscription(repo),
        /** Handle a verified webhook event (no Stripe gateway needed). */
        handleStripeWebhook: makeHandleStripeWebhook(repo),
        /**
         * Load the Stripe gateway, or null when billing is not configured.
         * Returns the gateway plus the gateway-bound use-cases.
         */
        async loadGateway(): Promise<{
            gateway: PaymentGateway
            createCheckout: ReturnType<typeof makeCreateCheckout>
        } | null> {
            const gateway = await StripePaymentGateway.load()
            if (!gateway) return null
            return { gateway, createCheckout: makeCreateCheckout(repo, gateway) }
        },
    }
}

export type BillingModule = ReturnType<typeof makeBillingModule>
