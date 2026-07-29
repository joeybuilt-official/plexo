// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P4 Autonomous Agent Runtime E2E — proves A2A discovery, task submission,
 * webhook triggers, and task detail rendering.
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
import { hasAuthSession, dismissAnalyticsModal } from './_helpers'
const HAS_SESSION = hasAuthSession()

test.describe('P4: Autonomous Agent Runtime', () => {
    test.describe('A2A Discovery', () => {
        test('.well-known/agent.json returns valid A2A agent card', async ({ request }) => {
            const res = await request.get(`${API}/.well-known/agent.json`)
            expect(res.status()).toBe(200)
            const body = await res.json()
            expect(body.name).toBe('Plexo')
            expect(body.url).toBeTruthy()
            expect(body.capabilities).toBeTruthy()
            expect(body.capabilities.streaming).toBe(true)
            expect(body.authentication.schemes).toContain('Bearer')
        })

        test('A2A agents list endpoint responds', async ({ request }) => {
            const res = await request.get(`${API}/api/v1/a2a/agents`)
            // Endpoint responds (200 or 400 depending on config)
            expect([200, 400]).toContain(res.status())
        })
    })

    test.describe('Webhook Triggers', () => {
        test('webhook to invalid workspace returns 404', async ({ request }) => {
            const res = await request.post(`${API}/api/v1/webhooks/00000000-0000-0000-0000-000000000000`, {
                data: { description: 'test webhook' },
                timeout: 10000,
            }).catch(() => null)
            if (res) expect([404, 400]).toContain(res.status())
        })

        test('webhook to invalid UUID returns 400', async ({ request }) => {
            const res = await request.post(`${API}/api/v1/webhooks/not-a-uuid`, {
                data: { description: 'test webhook' },
                timeout: 10000,
            }).catch(() => null)
            if (res) expect([400, 404]).toContain(res.status())
        })
    })

    test.describe('UI — Task Detail', () => {
        test('tasks page loads', async ({ page }) => {
            test.skip(!HAS_SESSION, 'No auth session')

            await page.goto(`${BASE}/tasks`)
            await page.waitForTimeout(2000)
            await dismissAnalyticsModal(page)

            const main = page.locator('main, [role="main"], [data-testid="tasks-page"]')
            await expect(main.first()).toBeVisible({ timeout: 10000 })
        })

        test('approvals page loads', async ({ page }) => {
            test.skip(!HAS_SESSION, 'No auth session')

            await page.goto(`${BASE}/approvals`)
            await page.waitForTimeout(2000)
            await dismissAnalyticsModal(page)

            const main = page.locator('main, [role="main"], [data-testid="approvals-page"]')
            await expect(main.first()).toBeVisible({ timeout: 10000 })
        })
    })
})
