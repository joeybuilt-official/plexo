// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Billing data-access repository.
 *
 * arch-findings B1 — owns the `user_subscriptions` table SQL behind the billing
 * routes. All Stripe SDK calls, checkout-session creation, webhook signature
 * verification, tier/status mapping, and the get-or-create race orchestration
 * stay in the route. Only the SQL moves here; every query is scoped to the
 * caller's userId verbatim.
 */
import { db, eq, sql } from '@plexo/db'
import { userSubscriptions } from '@plexo/db'

type UserSubscription = typeof userSubscriptions.$inferSelect

/** Subscription row for a user, or undefined. */
export async function getByUserId(userId: string): Promise<UserSubscription | undefined> {
    const [row] = await db
        .select()
        .from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId))
        .limit(1)
    return row
}

/** Insert a default free subscription for a user (no-op on conflict); returns the row if inserted. */
export async function insertDefault(userId: string): Promise<UserSubscription | undefined> {
    const [row] = await db
        .insert(userSubscriptions)
        .values({ userId, tier: 'free', status: 'active' })
        .onConflictDoNothing()
        .returning()
    return row
}

/** Upsert a user's subscription from a Stripe webhook (insert-or-update on userId). */
export async function upsertFromStripe(values: typeof userSubscriptions.$inferInsert): Promise<void> {
    await db
        .insert(userSubscriptions)
        .values(values)
        .onConflictDoUpdate({
            target: userSubscriptions.userId,
            set: {
                tier: values.tier,
                status: values.status,
                stripeCustomerId: values.stripeCustomerId,
                stripeSubscriptionId: values.stripeSubscriptionId,
                currentPeriodEnd: values.currentPeriodEnd,
                trialEndsAt: values.trialEndsAt,
                updatedAt: sql`now()`,
            },
        })
}
