// Integration test vitest config — uses tsx/esm transform for full Node compat
// Run with: pnpm test:integration (sets DATABASE_URL via env prefix)
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
    resolve: {
        // Array form with regex `find` so the bare-package aliases don't
        // intercept subpath imports (e.g. `@plexo/agent/planner`); subpaths
        // fall through to Node, which resolves via each package's `exports`.
        alias: [
            { find: /^@plexo\/auth\/config$/, replacement: resolve('./packages/auth/src/config.ts') },
            { find: /^@plexo\/auth$/, replacement: resolve('./packages/auth/src/index.ts') },
            { find: /^@plexo\/db$/, replacement: resolve('./packages/db/src/index.ts') },
            { find: /^@plexo\/agent$/, replacement: resolve('./packages/agent/src/index.ts') },
            { find: /^@plexo\/queue$/, replacement: resolve('./packages/queue/src/index.ts') },
            { find: /^@plexo\/sdk$/, replacement: resolve('./packages/sdk/src/index.ts') },
            // Bare specifiers for integration tests that import directly from
            // apps/api source. The packages aren't hoisted to the repo root,
            // so pin them to the api workspace's node_modules.
            { find: /^express$/, replacement: resolve('./apps/api/node_modules/express/index.js') },
            { find: /^pg$/, replacement: resolve('./apps/api/node_modules/pg/lib/index.js') },
            { find: /^better-auth$/, replacement: resolve('./apps/api/node_modules/better-auth/dist/index.mjs') },
        ],
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
                inline: ['@plexo/db', '@plexo/auth', '@plexo/auth/config', '@plexo/queue', '@plexo/agent', '@joeybuilt/plexo-sdk'],
            },
        },
    },
})
