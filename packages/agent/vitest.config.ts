// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// A package-local config is required here — running vitest from this package
// with NO config picks up the repo-root vitest.config.ts, which lacks the
// inline below. Keep setupFiles pointed at the shared root setup so env vars
// (PLEXO_SIGNING_SECRET, DATABASE_URL fallback, ANTHROPIC_API_KEY) stay
// identical to the root suite; a local config otherwise suppresses them.
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        testTimeout: 15_000,
        setupFiles: [resolve(__dirname, '../../tests/setup.ts')],
        server: {
            deps: {
                inline: ['@plexo/queue'],
            },
        },
    },
})
