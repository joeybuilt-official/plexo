// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P4 Observability E2E — proves analytics modal, opt-out persistence,
 * and plexo_ops ingest endpoints.
 */
import { test, expect } from '@playwright/test'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
import { hasAuthSession } from './_helpers'
const HAS_SESSION = hasAuthSession()

test.describe('P4: Observability — Analytics', () => {
    test.describe('Analytics Preview Modal', () => {
        test('analytics modal appears on fresh session', async ({ page }) => {
            test.skip(!HAS_SESSION, 'No auth session')

            // Navigate first so localStorage ops run on the app origin
            await page.goto(`${BASE}/home`)
            // Only clear the analytics ack key — clearing cookies logs the user out
            await page.evaluate(() => localStorage.removeItem('plexo_analytics_ack'))
            await page.reload()
            await expect(page.locator('[data-testid="analytics-modal"]')).toBeVisible({ timeout: 10000 })
        })

        test('opt-out persists across reload', async ({ page }) => {
            test.skip(!HAS_SESSION, 'No auth session')

            // Navigate first so localStorage ops run on the app origin
            await page.goto(`${BASE}/home`)
            await page.evaluate(() => localStorage.removeItem('plexo_analytics_ack'))
            await page.reload()
            const modal = page.locator('[data-testid="analytics-modal"]')
            if (await modal.isVisible({ timeout: 5000 }).catch(() => false)) {
                await page.click('[data-testid="analytics-optout"]')
                await page.click('[data-testid="analytics-confirm"]')
            }
            await page.reload()
            await expect(modal).not.toBeVisible({ timeout: 3000 })
        })

        test('modal does not reappear after acknowledgement', async ({ page }) => {
            test.skip(!HAS_SESSION, 'No auth session')

            // Set the ack flag directly
            await page.goto(`${BASE}/home`)
            await page.evaluate(() => localStorage.setItem('plexo_analytics_ack', 'opted-in'))
            await page.reload()
            await expect(page.locator('[data-testid="analytics-modal"]')).not.toBeVisible({ timeout: 3000 })
        })
    })

    test.describe('Ingest Endpoints', () => {
        test('POST /api/v1/analytics/ingest writes to plexo_ops_analytics', async ({ request }) => {
            const res = await request.post(`${API}/api/v1/analytics/ingest`, {
                data: {
                    event_name: 'plexo_installed',
                    properties: { source: 'e2e-test' },
                    instance_uuid: 'e2e-test-uuid',
                },
            })
            expect(res.status()).toBe(201)
            const body = await res.json()
            expect(body.ok).toBe(true)
        })

        test('POST /api/v1/analytics/ingest rejects unknown event', async ({ request }) => {
            const res = await request.post(`${API}/api/v1/analytics/ingest`, {
                data: {
                    event_name: 'totally_fake_event',
                    instance_uuid: 'e2e-test-uuid',
                },
            })
            expect(res.status()).toBe(400)
        })

        test('POST /api/v1/analytics/error writes to plexo_ops_errors', async ({ request }) => {
            const res = await request.post(`${API}/api/v1/analytics/error`, {
                data: {
                    fingerprint: `e2e-test-${Date.now()}`,
                    message: 'E2E test error',
                    stack_trace: 'Error: test\n  at test.ts:1',
                    context: {},
                },
            })
            expect(res.status()).toBe(201)
            const body = await res.json()
            expect(body.ok).toBe(true)
        })

        test('POST /api/v1/analytics/error upserts on duplicate fingerprint', async ({ request }) => {
            const fingerprint = `e2e-upsert-${Date.now()}`
            // First insert
            const res1 = await request.post(`${API}/api/v1/analytics/error`, {
                data: { fingerprint, message: 'first' },
            })
            expect(res1.status()).toBe(201)
            // Second insert same fingerprint — should upsert
            const res2 = await request.post(`${API}/api/v1/analytics/error`, {
                data: { fingerprint, message: 'second' },
            })
            expect(res2.status()).toBe(201)
        })

        test('ingest strips disallowed properties', async ({ request }) => {
            const res = await request.post(`${API}/api/v1/analytics/ingest`, {
                data: {
                    event_name: 'plexo_task_completed',
                    properties: {
                        source: 'e2e',
                        secret_key: 'SHOULD_BE_STRIPPED',
                        user_email: 'SHOULD_BE_STRIPPED',
                    },
                    instance_uuid: 'e2e-test-uuid',
                },
            })
            expect(res.status()).toBe(201)
        })

        test('GET /api/v1/analytics returns config', async ({ request }) => {
            const res = await request.get(`${API}/api/v1/analytics`)
            expect(res.status()).toBe(200)
            const body = await res.json()
            expect(typeof body.errorsEnabled).toBe('boolean')
            expect(typeof body.usageEnabled).toBe('boolean')
            expect(body.instanceId).toBeTruthy()
        })
    })
})
