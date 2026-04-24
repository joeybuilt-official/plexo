// Integration test vitest config — uses tsx/esm transform for full Node compat
// Run with: pnpm test:integration (sets DATABASE_URL via env prefix)
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    resolve: {
        alias: {
            '@plexo/db': resolve('./packages/db/src/index.ts'),
            '@plexo/agent': resolve('./packages/agent/src/index.ts'),
            '@plexo/queue': resolve('./packages/queue/src/index.ts'),
            '@plexo/sdk': resolve('./packages/sdk/src/index.ts'),
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
                inline: ['@plexo/db', '@plexo/queue', '@plexo/agent', '@plexo/sdk'],
            },
        },
    },
})
