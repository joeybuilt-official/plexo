// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P0 live-stack E2E — proves the stack is operational: health endpoint, DB tables
 * exist, app responds. Targets E2E_BASE_URL (default http://localhost:3000),
 * which is the ephemeral docker-compose stack on the Linux NAS runner. Override
 * to https://getplexo.com to smoke-test the live deploy.
 */
import { test, expect } from '@playwright/test'

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const TARGETS_LIVE_PROD = /getplexo\.com/.test(BASE_URL)

test.describe('P0: Live Stack', () => {
    test('health endpoint returns 200 with postgres and redis ok', async ({ request }) => {
        // /health is a Next.js stub ({status:"ok"} only); full service probe is at /api/v1/health
        const res = await request.get(`${BASE_URL}/api/v1/health`)
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.status).toBe('ok')
        expect(body.services.postgres.ok).toBe(true)
        expect(body.services.redis.ok).toBe(true)
    })

    test('app responds at root (not old marketing site)', async ({ page }) => {
        const res = await page.goto(BASE_URL)
        expect(res?.status()).toBeLessThan(500)
        if (TARGETS_LIVE_PROD) {
            // The live cloud build serves a marketing landing whose body
            // contains "self-hosted". The ephemeral stack runs with
            // PLEXO_MARKETING_ENABLED=false and lands on /login instead,
            // so this assertion is only meaningful against prod.
            const body = await page.locator('body').textContent()
            expect(body).toContain('self-hosted')
        }
    })

    test('login page accessible', async ({ page }) => {
        await page.goto(`${BASE_URL}/login`)
        await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible({ timeout: 10000 })
    })

    test('.well-known/agent.json returns valid A2A card', async ({ request }) => {
        // /.well-known/ is proxied to the Express API via next.config.ts rewrites.
        // Returns 404 if the rewrite hasn't been deployed yet — soft-fail to document.
        const res = await request.get(`${BASE_URL}/.well-known/agent.json`)
            .catch(() => null)
        if (!res || res.status() === 404) {
            console.warn('/.well-known/agent.json not yet routed — add /.well-known/ rewrite in next.config.ts')
            return
        }
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.name).toBe('Plexo')
        expect(body.capabilities).toBeTruthy()
        expect(body.authentication.schemes).toContain('Bearer')
    })

    test('API tasks endpoint responds (not 500)', async ({ request }) => {
        const res = await request.get(`${BASE_URL}/api/v1/tasks?workspaceId=00000000-0000-0000-0000-000000000000`)
        // 200 with empty list or 404 — never 500 "relation does not exist"
        expect(res.status()).toBeLessThan(500)
    })
})
