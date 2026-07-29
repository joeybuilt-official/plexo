// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Billing data-access adapter.
 *
 * Implements the `SubscriptionRepository` port over the `user_subscriptions`
 * table (slot 0071). This is the ONLY layer permitted to import drizzle. It
 * translates drizzle rows ↔ domain `Subscription` entities at the boundary so
 * the application/use-case layers never see a row shape. Every query is scoped
 * to the caller's userId verbatim; the SQL is unchanged from the pre-refactor
 * repository.
 */
import { eq, sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { userSubscriptions } from '@plexo/db'
import type { Subscription, SubscriptionRepository } from '../application/billing/ports.js'
import type { Tier, SubscriptionStatus } from '../domain/billing/subscription.js'

type UserSubscriptionRow = typeof userSubscriptions.$inferSelect

/** drizzle row → domain entity. */
function toEntity(row: UserSubscriptionRow): Subscription {
    return {
        tier: row.tier as Tier,
        status: row.status as SubscriptionStatus,
        stripeCustomerId: row.stripeCustomerId,
        stripeSubscriptionId: row.stripeSubscriptionId,
        currentPeriodEnd: row.currentPeriodEnd,
        trialEndsAt: row.trialEndsAt,
    }
}

export class DrizzleSubscriptionRepository implements SubscriptionRepository {
    /** Subscription entity for a user, or undefined. */
    async getByUserId(userId: string): Promise<Subscription | undefined> {
        const [row] = await db
            .select()
            .from(userSubscriptions)
            .where(eq(userSubscriptions.userId, userId))
            .limit(1)
        return row ? toEntity(row) : undefined
    }

    /** Insert a default free subscription (no-op on conflict); returns the entity if inserted. */
    async insertDefault(userId: string): Promise<Subscription | undefined> {
        const [row] = await db
            .insert(userSubscriptions)
            .values({ userId, tier: 'free', status: 'active' })
            .onConflictDoNothing()
            .returning()
        return row ? toEntity(row) : undefined
    }

    /** Upsert a user's subscription from a Stripe-derived entity (insert-or-update on userId). */
    async upsertFromStripe(userId: string, sub: Subscription): Promise<void> {
        await db
            .insert(userSubscriptions)
            .values({
                userId,
                tier: sub.tier,
                status: sub.status,
                stripeCustomerId: sub.stripeCustomerId,
                stripeSubscriptionId: sub.stripeSubscriptionId,
                currentPeriodEnd: sub.currentPeriodEnd,
                trialEndsAt: sub.trialEndsAt,
            })
            .onConflictDoUpdate({
                target: userSubscriptions.userId,
                set: {
                    tier: sub.tier,
                    status: sub.status,
                    stripeCustomerId: sub.stripeCustomerId,
                    stripeSubscriptionId: sub.stripeSubscriptionId,
                    currentPeriodEnd: sub.currentPeriodEnd,
                    trialEndsAt: sub.trialEndsAt,
                    updatedAt: sql`now()`,
                },
            })
    }
}
