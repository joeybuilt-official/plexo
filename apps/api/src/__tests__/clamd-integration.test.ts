// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0012 — clamd integration test (skipped unless CLAMD_HOST is set).
 *
 * Documents the production contract:
 *   - PING returns true
 *   - EICAR test signature is detected as infected
 *   - Innocuous bytes scan clean
 *
 * Not part of CI-by-default. To run locally:
 *   CLAMD_HOST=127.0.0.1 CLAMD_PORT=3310 pnpm -F @plexo/api test --run \
 *     apps/api/src/__tests__/clamd-integration.test.ts
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { pingClamd, instreamScan, type ClamdConfig } from '../lib/clamd-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const HOST = process.env.CLAMD_HOST
const PORT = Number(process.env.CLAMD_PORT ?? 3310)

const cfg: ClamdConfig = { host: HOST ?? '127.0.0.1', port: PORT, timeoutMs: 10_000 }

describe.skipIf(!HOST)('clamd integration (live daemon)', () => {
    it('pingClamd returns true against a real clamd', async () => {
        const ok = await pingClamd(cfg)
        expect(ok).toBe(true)
    })

    it('EICAR fixture is flagged infected with /eicar/i signature', async () => {
        const fixture = await readFile(resolve(__dirname, 'fixtures', 'eicar.txt'))
        const result = await instreamScan(cfg, fixture)
        expect(result.status).toBe('infected')
        expect(result.signature).toMatch(/eicar/i)
        expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('innocuous 100-byte buffer is scanned clean', async () => {
        const buf = Buffer.alloc(100, 0x20) // ASCII spaces
        const result = await instreamScan(cfg, buf)
        expect(result.status).toBe('clean')
        expect(result.signature).toBeUndefined()
    })
})
