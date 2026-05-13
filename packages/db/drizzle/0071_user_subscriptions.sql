-- 0071_user_subscriptions — Plexo SaaS subscription state.
--
-- Additive. References users by text id (Better Auth id) — NO foreign key because
-- users live behind postgres_fdw in pushd.auth.user and Postgres disallows FKs to
-- foreign tables. Referential integrity is enforced at the application layer.

CREATE TABLE IF NOT EXISTS user_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id text NOT NULL,
    tier text NOT NULL DEFAULT 'free',      -- 'free' | 'pro' | 'team' | 'enterprise'
    status text NOT NULL DEFAULT 'active',  -- 'active' | 'past_due' | 'canceled' | 'paused'
    stripe_customer_id text,
    stripe_subscription_id text,
    current_period_end timestamptz,
    trial_ends_at timestamptz,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_subscriptions_user_id_idx
    ON user_subscriptions(user_id);

CREATE INDEX IF NOT EXISTS user_subscriptions_stripe_customer_idx
    ON user_subscriptions(stripe_customer_id)
    WHERE stripe_customer_id IS NOT NULL;
