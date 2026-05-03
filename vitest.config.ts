import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Use __dirname so aliases resolve correctly regardless of CWD (turbo runs
// each package's test script from its own directory, not the repo root).
const root = __dirname

export default defineConfig({
    resolve: {
        alias: {
            // Subpath aliases must come BEFORE the bare-package alias so prefix matching works.
            '@plexo/agent/executor/step-builder': resolve(root, 'packages/agent/src/executor/step-builder.ts'),
            '@plexo/agent/executor': resolve(root, 'packages/agent/src/executor/index.ts'),
            '@plexo/agent/prompts/build-system-prompt': resolve(root, 'packages/agent/src/prompts/build-system-prompt.ts'),
            '@plexo/agent/providers/registry': resolve(root, 'packages/agent/src/providers/registry.ts'),
            '@plexo/agent/providers/chain-resolver': resolve(root, 'packages/agent/src/providers/chain-resolver.ts'),
            '@plexo/agent/providers/knowledge': resolve(root, 'packages/agent/src/providers/knowledge.ts'),
            '@plexo/agent/providers/call-model': resolve(root, 'packages/agent/src/providers/call-model.ts'),
            '@plexo/agent/providers/vision': resolve(root, 'packages/agent/src/providers/vision.ts'),
            '@plexo/agent/scl/pii-scrub': resolve(root, 'packages/agent/src/scl/pii-scrub.ts'),
            '@plexo/agent/principles': resolve(root, 'packages/agent/src/principles.ts'),
            '@plexo/agent/memory/store': resolve(root, 'packages/agent/src/memory/store.ts'),
            '@plexo/agent/memory/query': resolve(root, 'packages/agent/src/memory/query.ts'),
            '@plexo/agent/memory/preferences': resolve(root, 'packages/agent/src/memory/preferences.ts'),
            '@plexo/agent/memory/self-improvement': resolve(root, 'packages/agent/src/memory/self-improvement.ts'),
            '@plexo/agent/memory/prompt-improvement': resolve(root, 'packages/agent/src/memory/prompt-improvement.ts'),
            '@plexo/agent/memory/cluster': resolve(root, 'packages/agent/src/memory/cluster.ts'),
            '@plexo/agent/memory/suggest': resolve(root, 'packages/agent/src/memory/suggest.ts'),
            '@plexo/agent/memory/streaming-touch': resolve(root, 'packages/agent/src/memory/streaming-touch.ts'),
            '@plexo/agent/memory/scl': resolve(root, 'packages/agent/src/memory/scl.ts'),
            '@plexo/agent/memory/promote': resolve(root, 'packages/agent/src/memory/promote.ts'),
            '@plexo/agent/types': resolve(root, 'packages/agent/src/types.ts'),
            '@plexo/agent/embeddings/router': resolve(root, 'packages/agent/src/embeddings/router.ts'),
            '@plexo/agent/embeddings/adapters': resolve(root, 'packages/agent/src/embeddings/adapters.ts'),
            '@plexo/db/work-kind': resolve(root, 'packages/db/src/work-kind.ts'),
            '@plexo/db': resolve(root, 'packages/db/src/index.ts'),
            '@plexo/agent': resolve(root, 'packages/agent/src/index.ts'),
            '@plexo/queue': resolve(root, 'packages/queue/src/index.ts'),
            '@plexo/sdk': resolve(root, 'packages/sdk/src/index.ts'),
            '@plexo/storage': resolve(root, 'packages/storage/src/index.ts'),
            // apps/web internal alias — matches its tsconfig "paths"
            '@web': resolve(root, 'apps/web/src'),
        },
    },
    test: {
        globals: true,
        environment: 'node',
        setupFiles: [resolve(root, 'tests/setup.ts')],
        // Exclude integration and e2e tests from the unit suite
        // e2e tests are Playwright-based and run via pnpm test:e2e
        // node_modules/** must be **/node_modules/** to catch nested installs
        exclude: ['tests/integration/**', 'tests/e2e/**', '**/node_modules/**', '.claude/**'],
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
