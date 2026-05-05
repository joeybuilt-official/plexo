// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * L4.5 — pin that cron-dispatch's claim query uses FOR UPDATE SKIP LOCKED.
 *
 * This is a smoke test against the source — a full concurrency test requires
 * a real Postgres (pg-mem doesn't fully support FOR UPDATE SKIP LOCKED).
 * The smoke test catches the regression class where someone refactors the
 * dispatch query and accidentally drops the row-locking clause, which would
 * silently let two dispatch instances claim the same row and double-fire.
 */

import { describe, it, expect } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('cron-dispatch concurrency invariant (L4.5)', () => {
    it('claim query includes FOR UPDATE SKIP LOCKED (regression guard)', async () => {
        const src = await readFile(resolve(__dirname, '../cron-dispatch.ts'), 'utf8')
        // Strip line comments / block comments to avoid false matches.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '')
            .replace(/\s+/g, ' ')
        expect(code).toMatch(/FROM cron_jobs.*?WHERE enabled = true.*?LIMIT.*?FOR UPDATE SKIP LOCKED/)
    })

    it('source comment names the FUN-038 ticket so the rationale is preserved', async () => {
        const src = await readFile(resolve(__dirname, '../cron-dispatch.ts'), 'utf8')
        expect(src).toMatch(/FUN-038/)
        expect(src).toMatch(/concurrent dispatch instances/i)
    })
})
