// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Use-case: read the caller's subscription, creating a default free one if
 * none exists. Handles the insert race (another request may insert first).
 */

import type { Subscription, SubscriptionRepository } from './ports.js'

export function makeGetSubscription(repo: SubscriptionRepository) {
    return async function getSubscription(userId: string): Promise<Subscription> {
        const existing = await repo.getByUserId(userId)
        if (existing) return existing

        const inserted = await repo.insertDefault(userId)
        if (inserted) return inserted
        // Race — another request inserted first. Re-read.
        return (await repo.getByUserId(userId))!
    }
}

export type GetSubscription = ReturnType<typeof makeGetSubscription>
