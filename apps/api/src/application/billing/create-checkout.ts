// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Use-case: start a Stripe Checkout Session for the caller. Resolves (or
 * creates) the subscription first so we can reuse an existing Stripe customer,
 * then delegates the session creation to the PaymentGateway.
 */

import type { CheckoutResult, PaymentGateway, SubscriptionRepository } from './ports.js'
import { makeGetSubscription } from './get-subscription.js'

export interface CreateCheckoutInput {
    userId: string
    email: string
    priceId: string
    successUrl: string
    cancelUrl: string
}

export function makeCreateCheckout(repo: SubscriptionRepository, gateway: PaymentGateway) {
    const getSubscription = makeGetSubscription(repo)
    return async function createCheckout(input: CreateCheckoutInput): Promise<CheckoutResult> {
        const sub = await getSubscription(input.userId)
        return gateway.createCheckoutSession({
            priceId: input.priceId,
            userId: input.userId,
            email: input.email,
            stripeCustomerId: sub.stripeCustomerId,
            successUrl: input.successUrl,
            cancelUrl: input.cancelUrl,
        })
    }
}

export type CreateCheckout = ReturnType<typeof makeCreateCheckout>
