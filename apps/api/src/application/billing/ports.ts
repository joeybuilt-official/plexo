// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Billing application ports.
 *
 * These interfaces invert the dependency on infrastructure: use-cases depend on
 * these abstractions, and adapters (drizzle, stripe) implement them. The domain
 * vocabulary (`Subscription`, `Tier`, `SubscriptionStatus`) crosses the
 * boundary — never drizzle rows or Stripe SDK types.
 *
 * Lightweight by design: drizzle stays the only `SubscriptionRepository`
 * adapter and stripe the only `PaymentGateway` adapter. The ports exist to
 * enforce the Dependency Rule and to make use-cases unit-testable with fakes,
 * not to abstract over multiple backends.
 */

import type { Subscription, Tier, SubscriptionStatus } from '../../domain/billing/subscription.js'

/** Persistence of subscriptions, in domain-entity terms. */
export interface SubscriptionRepository {
    /** The user's subscription, or undefined when none exists yet. */
    getByUserId(userId: string): Promise<Subscription | undefined>
    /** Insert the default free subscription (no-op on conflict); returns it if inserted. */
    insertDefault(userId: string): Promise<Subscription | undefined>
    /** Insert-or-update a user's subscription from a Stripe-derived entity. */
    upsertFromStripe(userId: string, sub: Subscription): Promise<void>
}

/** Parameters for creating a Stripe Checkout Session, in plain terms. */
export interface CheckoutParams {
    priceId: string
    userId: string
    email: string
    /** The customer's existing Stripe id, if we've created one before. */
    stripeCustomerId: string | null
    successUrl: string
    cancelUrl: string
}

/** Result of a created Checkout Session. */
export interface CheckoutResult {
    url: string | null
    sessionId: string
}

/** A verified Stripe webhook event (only the shape billing cares about). */
export interface StripeWebhookEvent {
    type: string
    data: { object: Record<string, unknown> }
}

/** Payment provider boundary (Stripe). */
export interface PaymentGateway {
    createCheckoutSession(params: CheckoutParams): Promise<CheckoutResult>
    /**
     * Verify a raw webhook body against its signature and return the event.
     * Throws when verification fails (caller maps that to a 400).
     */
    constructWebhookEvent(rawBody: Buffer, signature: string, secret: string): StripeWebhookEvent
}

export type { Subscription, Tier, SubscriptionStatus }
