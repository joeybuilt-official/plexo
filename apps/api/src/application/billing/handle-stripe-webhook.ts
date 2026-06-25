// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Use-case: handle a verified Stripe webhook event. Only subscription
 * lifecycle events mutate state; everything else is ignored. Tier/status are
 * resolved by the pure domain rules.
 */

import type { StripeWebhookEvent, SubscriptionRepository } from './ports.js'
import { resolveTierFromPrice, mapStripeStatus } from '../../domain/billing/subscription.js'

export function makeHandleStripeWebhook(repo: SubscriptionRepository) {
    return async function handleStripeWebhook(event: StripeWebhookEvent): Promise<void> {
        const type = event.type

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
                    // Caller logs the warning; nothing to persist without a user.
                    return
                }

                const tierFromPrice = resolveTierFromPrice(sub.items?.data?.[0]?.price)
                const tier = type === 'customer.subscription.deleted' ? 'free' : tierFromPrice
                const status = mapStripeStatus(sub.status)

                await repo.upsertFromStripe(plexoUserId, {
                    tier,
                    status,
                    stripeCustomerId: sub.customer,
                    stripeSubscriptionId: sub.id,
                    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
                    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000) : null,
                })
                return
            }
            default:
                // Silently ignore unhandled event types — Stripe sends many, we
                // only care about subscription lifecycle for now.
                return
        }
    }
}

export type HandleStripeWebhook = ReturnType<typeof makeHandleStripeWebhook>
