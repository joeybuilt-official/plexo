import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    resolve: {
        alias: {
            '@plexo/db': resolve('./packages/db/src/index.ts'),
            '@plexo/agent': resolve('./packages/agent/src/index.ts'),
            '@plexo/queue': resolve('./packages/queue/src/index.ts'),
            '@plexo/sdk': resolve('./packages/sdk/src/index.ts'),
            '@plexo/storage': resolve('./packages/storage/src/index.ts'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./tests/setup.ts'],
        // Exclude integration tests from the unit suite — they run via pnpm test:integration
        exclude: ['tests/integration/**', 'node_modules/**'],
        pool: 'forks',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary'],
            include: ['packages/*/src/**', 'apps/*/src/**'],
            exclude: ['**/node_modules/**', '**/*.d.ts'],
        },
        testTimeout: 15_000,
    },
})
