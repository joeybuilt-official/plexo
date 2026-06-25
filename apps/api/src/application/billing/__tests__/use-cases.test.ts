// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Billing use-case unit tests.
 *
 * Exercises the use-cases against in-memory fake ports — no DB, no HTTP, no
 * Stripe SDK. Proves the application layer is decoupled from infrastructure.
 */

import { describe, it, expect, vi } from 'vitest'
import { makeGetSubscription } from '../get-subscription.js'
import { makeCreateCheckout } from '../create-checkout.js'
import { makeHandleStripeWebhook } from '../handle-stripe-webhook.js'
import type {
    CheckoutParams,
    CheckoutResult,
    PaymentGateway,
    StripeWebhookEvent,
    Subscription,
    SubscriptionRepository,
} from '../ports.js'

function freeSub(over: Partial<Subscription> = {}): Subscription {
    return {
        tier: 'free',
        status: 'active',
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        currentPeriodEnd: null,
        trialEndsAt: null,
        ...over,
    }
}

class FakeRepo implements SubscriptionRepository {
    store = new Map<string, Subscription>()
    insertDefaultReturnsNull = false
    upserts: Array<{ userId: string; sub: Subscription }> = []

    async getByUserId(userId: string): Promise<Subscription | undefined> {
        return this.store.get(userId)
    }
    async insertDefault(userId: string): Promise<Subscription | undefined> {
        if (this.insertDefaultReturnsNull) return undefined
        const sub = freeSub()
        this.store.set(userId, sub)
        return sub
    }
    async upsertFromStripe(userId: string, sub: Subscription): Promise<void> {
        this.upserts.push({ userId, sub })
        this.store.set(userId, sub)
    }
}

class FakeGateway implements PaymentGateway {
    lastParams: CheckoutParams | null = null
    result: CheckoutResult = { url: 'https://stripe.test/cs', sessionId: 'cs_fake' }
    async createCheckoutSession(params: CheckoutParams): Promise<CheckoutResult> {
        this.lastParams = params
        return this.result
    }
    constructWebhookEvent(): StripeWebhookEvent {
        throw new Error('not used in these tests')
    }
}

// ── get-subscription ─────────────────────────────────────────────────────────

describe('getSubscription use-case', () => {
    it('returns the existing subscription when present', async () => {
        const repo = new FakeRepo()
        repo.store.set('u1', freeSub({ tier: 'pro' }))
        const getSubscription = makeGetSubscription(repo)
        const sub = await getSubscription('u1')
        expect(sub.tier).toBe('pro')
    })

    it('creates a default free subscription when none exists', async () => {
        const repo = new FakeRepo()
        const getSubscription = makeGetSubscription(repo)
        const sub = await getSubscription('u2')
        expect(sub.tier).toBe('free')
        expect(sub.status).toBe('active')
    })

    it('re-reads on insert race (insertDefault returns undefined)', async () => {
        const repo = new FakeRepo()
        repo.insertDefaultReturnsNull = true
        // Simulate another request having inserted first: present on re-read.
        const racer = freeSub({ tier: 'team' })
        const origGet = repo.getByUserId.bind(repo)
        let calls = 0
        repo.getByUserId = vi.fn(async (id: string) => {
            calls += 1
            if (calls === 1) return undefined // first read: empty
            repo.store.set(id, racer)
            return origGet(id)
        })
        const getSubscription = makeGetSubscription(repo)
        const sub = await getSubscription('u3')
        expect(sub.tier).toBe('team')
    })
})

// ── create-checkout ──────────────────────────────────────────────────────────

describe('createCheckout use-case', () => {
    it('passes email and no customer when no existing stripe customer', async () => {
        const repo = new FakeRepo()
        repo.store.set('u1', freeSub({ stripeCustomerId: null }))
        const gw = new FakeGateway()
        const createCheckout = makeCreateCheckout(repo, gw)
        const res = await createCheckout({
            userId: 'u1', email: 'a@b.co', priceId: 'price_x',
            successUrl: 's', cancelUrl: 'c',
        })
        expect(res.sessionId).toBe('cs_fake')
        expect(gw.lastParams?.email).toBe('a@b.co')
        expect(gw.lastParams?.stripeCustomerId).toBeNull()
    })

    it('forwards the existing stripe customer id', async () => {
        const repo = new FakeRepo()
        repo.store.set('u1', freeSub({ tier: 'pro', stripeCustomerId: 'cus_existing' }))
        const gw = new FakeGateway()
        const createCheckout = makeCreateCheckout(repo, gw)
        await createCheckout({
            userId: 'u1', email: 'a@b.co', priceId: 'price_x',
            successUrl: 's', cancelUrl: 'c',
        })
        expect(gw.lastParams?.stripeCustomerId).toBe('cus_existing')
    })
})

// ── handle-stripe-webhook ────────────────────────────────────────────────────

function subEvent(type: string, status: string, lookupKey: string, plexoUserId = 'u9'): StripeWebhookEvent {
    return {
        type,
        data: {
            object: {
                id: 'sub_test',
                customer: 'cus_test',
                status,
                current_period_end: 1800000000,
                trial_end: null,
                metadata: { plexoUserId },
                items: { data: [{ price: { id: 'price_test', lookup_key: lookupKey } }] },
            },
        },
    }
}

describe('handleStripeWebhook use-case', () => {
    it('upserts tier=pro status=active for a pro subscription.created', async () => {
        const repo = new FakeRepo()
        const handle = makeHandleStripeWebhook(repo)
        await handle(subEvent('customer.subscription.created', 'active', 'pro_monthly'))
        expect(repo.upserts).toHaveLength(1)
        expect(repo.upserts[0]?.sub.tier).toBe('pro')
        expect(repo.upserts[0]?.sub.status).toBe('active')
    })

    it('forces tier=free on subscription.deleted regardless of price', async () => {
        const repo = new FakeRepo()
        const handle = makeHandleStripeWebhook(repo)
        await handle(subEvent('customer.subscription.deleted', 'canceled', 'pro_monthly'))
        expect(repo.upserts[0]?.sub.tier).toBe('free')
        expect(repo.upserts[0]?.sub.status).toBe('canceled')
    })

    it('maps trialing → active', async () => {
        const repo = new FakeRepo()
        const handle = makeHandleStripeWebhook(repo)
        await handle(subEvent('customer.subscription.updated', 'trialing', 'pro_monthly'))
        expect(repo.upserts[0]?.sub.status).toBe('active')
    })

    it('does not upsert when plexoUserId metadata is missing', async () => {
        const repo = new FakeRepo()
        const handle = makeHandleStripeWebhook(repo)
        await handle({
            type: 'customer.subscription.updated',
            data: { object: { id: 'sub_test', customer: 'cus_test', status: 'active', metadata: {} } },
        })
        expect(repo.upserts).toHaveLength(0)
    })

    it('ignores unhandled event types', async () => {
        const repo = new FakeRepo()
        const handle = makeHandleStripeWebhook(repo)
        await handle({ type: 'payment_intent.created', data: { object: {} } })
        expect(repo.upserts).toHaveLength(0)
    })
})
