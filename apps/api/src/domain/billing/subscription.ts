// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Billing domain — framework-free subscription model and pure rules.
 *
 * This is the innermost ring (Clean Architecture): it imports nothing from
 * drizzle, express, or stripe. It owns the vocabulary (`Tier`,
 * `SubscriptionStatus`, the `Subscription` entity) and the two pure business
 * rules that translate raw Stripe inputs into that vocabulary.
 */

export type Tier = 'free' | 'pro' | 'team' | 'enterprise'

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'paused'

/** A user's billing subscription, in domain terms (not a drizzle row). */
export interface Subscription {
    tier: Tier
    status: SubscriptionStatus
    stripeCustomerId: string | null
    stripeSubscriptionId: string | null
    currentPeriodEnd: Date | null
    trialEndsAt: Date | null
}

/**
 * Resolve a billing tier from a Stripe price. Prefers the price's lookup_key,
 * then falls back to env-pinned price ids, defaulting to 'pro'.
 *
 * Moved verbatim from routes/billing.ts — behavior identical.
 */
export function resolveTierFromPrice(price: { id?: string; lookup_key?: string } | undefined): Tier {
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

/**
 * Map a raw Stripe subscription status to our domain status.
 *
 * Moved verbatim from routes/billing.ts — behavior identical.
 */
export function mapStripeStatus(stripeStatus: string): SubscriptionStatus {
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
