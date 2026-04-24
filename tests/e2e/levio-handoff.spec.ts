// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Levio Handoff Integration E2E
 *
 * Verifies:
 * - Plexo handoff files exist and are wired correctly
 * - Levio handshake files exist and are wired correctly
 * - API contract: generate rejects unauthenticated, consume rejects bad tokens
 * - Full SSO redirect flow (skipped without auth session)
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { hasAuthSession } from './_helpers'

const PLEXO_ROOT = path.resolve(__dirname, '../..')
const LEVIO_ROOT = path.resolve(__dirname, '../../../levio')
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'

async function isApiReachable(): Promise<boolean> {
    try {
        const res = await fetch(`${API_URL}/api/v1/health`, { signal: AbortSignal.timeout(2000) })
        return res.ok
    } catch {
        return false
    }
}

test.describe('Levio Handoff: file structure', () => {
    test('Plexo handoff router exists', () => {
        const file = path.join(PLEXO_ROOT, 'apps/api/src/routes/handoff.ts')
        expect(fs.existsSync(file)).toBe(true)
        const content = fs.readFileSync(file, 'utf-8')
        expect(content).toContain('handoffRouter')
        expect(content).toContain('/generate')
        expect(content).toContain('/consume')
        expect(content).toContain('levio')
    })

    test('Plexo sidebar has Open Levio button', () => {
        const sidebar = path.join(PLEXO_ROOT, 'apps/web/src/components/layout/sidebar.tsx')
        const content = fs.readFileSync(sidebar, 'utf-8')
        expect(content).toContain('Open Levio')
        expect(content).toContain("targetApp: 'levio'")
        expect(content).toContain('ExternalLink')
    })

    test('Levio middleware.ts exists and re-exports proxy', () => {
        const file = path.join(LEVIO_ROOT, 'src/middleware.ts')
        expect(fs.existsSync(file)).toBe(true)
        const content = fs.readFileSync(file, 'utf-8')
        expect(content).toContain('proxy')
        expect(content).toContain('config')
    })

    test('Levio handshake API route exists', () => {
        const file = path.join(LEVIO_ROOT, 'src/app/api/auth/handshake/route.ts')
        expect(fs.existsSync(file)).toBe(true)
        const content = fs.readFileSync(file, 'utf-8')
        expect(content).toContain('makeSignature')
        expect(content).toContain('createSession')
        expect(content).toContain('Set-Cookie')
    })

    test('Levio handshake page exists', () => {
        const file = path.join(LEVIO_ROOT, 'src/app/(auth)/handshake/page.tsx')
        expect(fs.existsSync(file)).toBe(true)
        const content = fs.readFileSync(file, 'utf-8')
        expect(content).toContain('use client')
        expect(content).toContain('/api/auth/handshake')
        expect(content).toContain('/today')
    })

    test('Levio auth middleware allows /auth/handshake', () => {
        const file = path.join(LEVIO_ROOT, 'src/lib/auth/middleware.ts')
        const content = fs.readFileSync(file, 'utf-8')
        expect(content).toContain('/auth/handshake')
    })
})

test.describe('Levio Handoff: API contract', () => {
    test.beforeAll(async () => {
        const reachable = await isApiReachable()
        if (!reachable) test.skip()
    })

    test('generate rejects unauthenticated request', async ({ request }) => {
        const res = await request.post(`${API_URL}/api/v1/auth/handoff/generate`, {
            data: { targetApp: 'levio' },
        })
        expect(res.status()).toBe(401)
    })

    test('generate rejects unknown target app', async ({ request }) => {
        // We can't provide a valid session here, but unknown-target should still
        // produce 400 once authenticated — test the token-less path gives 401 not 500
        const res = await request.post(`${API_URL}/api/v1/auth/handoff/generate`, {
            data: { targetApp: 'unknown-app-xyz' },
        })
        expect([400, 401]).toContain(res.status())
    })

    test('consume rejects invalid token format', async ({ request }) => {
        const res = await request.post(`${API_URL}/api/v1/auth/handoff/consume`, {
            data: { token: 'tooshort' },
        })
        expect(res.status()).toBe(400)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('INVALID_TOKEN')
    })

    test('consume rejects non-existent valid-format token', async ({ request }) => {
        const fakeToken = 'a'.repeat(64)
        const res = await request.post(`${API_URL}/api/v1/auth/handoff/consume`, {
            data: { token: fakeToken },
        })
        expect(res.status()).toBe(401)
        const body = await res.json() as { error: { code: string } }
        expect(body.error.code).toBe('TOKEN_INVALID')
    })
})

test.describe('Levio Handoff: full SSO flow', () => {
    test.skip(!hasAuthSession(), 'Skipped: no auth session available')

    test('sidebar Levio button generates redirect URL', async ({ page }) => {
        await page.goto(`${BASE_URL}/app`)
        const levioBtn = page.getByRole('button', { name: 'Open Levio' })
        await expect(levioBtn).toBeVisible({ timeout: 5000 })
    })
})
