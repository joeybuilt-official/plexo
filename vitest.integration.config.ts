// Integration test vitest config — uses tsx/esm transform for full Node compat
// Run with: pnpm test:integration (sets DATABASE_URL via env prefix)
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    resolve: {
        alias: {
            '@plexo/db/auth/config': resolve('./packages/db/src/auth/config.ts'),
            '@plexo/db': resolve('./packages/db/src/index.ts'),
            '@plexo/agent': resolve('./packages/agent/src/index.ts'),
            '@plexo/queue': resolve('./packages/queue/src/index.ts'),
            '@plexo/sdk': resolve('./packages/sdk/src/index.ts'),
            // Bare specifiers for integration tests that import directly from
            // apps/api source. The packages aren't hoisted to the repo root,
            // so pin them to the api workspace's node_modules.
            express: resolve('./apps/api/node_modules/express/index.js'),
            pg: resolve('./apps/api/node_modules/pg/lib/index.js'),
            'better-auth': resolve('./apps/api/node_modules/better-auth/dist/index.mjs'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./tests/setup.ts'],
        include: ['tests/integration/**/*.test.ts'],
        // Each integration test file gets its own process — avoids connection pool overlap
        pool: 'forks',
        poolOptions: {
            forks: {
                singleFork: false,
            },
        },
        testTimeout: 30_000,
        // Inline workspace packages; externalize everything else for native resolution
        server: {
            deps: {
                inline: ['@plexo/db', '@plexo/db/auth/config', '@plexo/queue', '@plexo/agent', '@plexo/sdk'],
            },
        },
    },
})
