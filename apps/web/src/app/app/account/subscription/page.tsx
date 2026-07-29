// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { SubscriptionClient } from './subscription-client'

export const metadata = { title: 'Subscription — Plexo' }

export default function SubscriptionPage() {
    const stripeProPriceId = process.env.STRIPE_PRICE_ID_PRO ?? null
    return <SubscriptionClient stripeProPriceId={stripeProPriceId} />
}
