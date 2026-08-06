// Set required env vars before any module is loaded in unit tests.
// DATABASE_URL points to the running dev DB so the postgres driver can
// initialise — actual DB methods are mocked per-test so no real writes happen.
// Prefer DATABASE_URL/REDIS_URL from the environment (set by CI or docker-compose).
// Fall back to the standard local dev defaults so unit tests can boot the pg driver.
process.env.DATABASE_URL ??= 'postgresql://plexo:plexo@localhost:5432/plexo'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test-unit'
// Managed-proxy request signing fails closed on an unset secret (router.ts) —
// provide a deterministic test value so proxy-mode routing tests can sign.
process.env.PLEXO_SIGNING_SECRET = 'test-signing-secret'
process.env.NODE_ENV = 'test'

