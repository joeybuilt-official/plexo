// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// See packages/agent/vitest.config.ts — a package-local config is required
// so `server.deps.inline` applies when vitest runs from this directory
// (inheriting the repo-root config drops it), and setupFiles must be
// re-declared to keep the shared env from tests/setup.ts.
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
