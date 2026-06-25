# Billing — Clean Architecture layer convention (Phase 0 pilot)

This bounded context is the reference for the Clean Architecture layering used
across `apps/api`. The dependency arrows point **inward**:

```
controllers / adapters  →  application (use-cases + ports)  →  domain
        (outer)                       (middle)                  (inner)
```

A layer may only depend on layers to its right. Infrastructure is inverted via
**ports**: use-cases depend on port interfaces, and adapters implement them.

## Rings

| Ring | Path | May import | MUST NOT import |
|---|---|---|---|
| **Domain** | `domain/billing/` | nothing framework-y | drizzle, express, stripe |
| **Application** | `application/billing/` | domain + own ports | drizzle, stripe, express |
| **Adapters** | `repositories/`, `infrastructure/billing/` | application ports + domain + their infra (drizzle / stripe) | express |
| **Controller** | `routes/billing.ts` | the composition factory (`application/billing`) | drizzle, stripe directly |

## Files

- `domain/billing/subscription.ts` — `Tier`, `SubscriptionStatus`, the
  `Subscription` entity, and the pure rules `resolveTierFromPrice` /
  `mapStripeStatus`. Framework-free.
- `application/billing/ports.ts` — `SubscriptionRepository` and `PaymentGateway`
  interfaces, expressed in domain-entity terms (never drizzle rows / Stripe
  types).
- `application/billing/{get-subscription,create-checkout,handle-stripe-webhook}.ts`
  — one orchestration each, depending only on the ports.
- `application/billing/index.ts` — composition root: builds the concrete
  adapters and wires the use-cases (lightweight constructor/factory DI).
- `repositories/billing.repository.ts` — `DrizzleSubscriptionRepository`, the
  only drizzle adapter; maps rows ↔ entities at the boundary.
- `infrastructure/billing/stripe-gateway.ts` — `StripePaymentGateway`, the only
  stripe adapter; wraps the lazy `getStripe` singleton + checkout +
  `constructEvent`.

## Ports are lightweight

Ports exist for the **Dependency Rule** and **testability** (use-cases run
against in-memory fakes — see `application/billing/__tests__/`). Drizzle stays
the only `SubscriptionRepository` and Stripe the only `PaymentGateway`. Do not
add abstraction for backends that don't exist.
