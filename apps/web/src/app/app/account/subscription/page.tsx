// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { SubscriptionClient } from './subscription-client'

export const metadata = { title: 'Subscription — Plexo' }

export default function SubscriptionPage() {
    const stripeProPriceId = process.env.STRIPE_PRICE_ID_PRO ?? null
    return <SubscriptionClient stripeProPriceId={stripeProPriceId} />
}
