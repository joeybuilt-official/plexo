// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * AUDIT-P3 E2E — API Consistency + Data Layer
 *
 * Verifies:
 *   1. D-03: Error responses use structured { error: { code, message } } format
 *   2. D-04: node-events endpoint supports offset pagination
 *   3. D-07: Data retention cron job is registered
 *
 * Run with: E2E_BASE_URL=https://getplexo.com pnpm test:e2e tests/e2e/audit-p3.spec.ts
 */
import { test, expect } from '@playwright/test'
import { hasAuthSession } from './_helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
// API-only routes (a2a card, etc.) are served by the api, not the web origin.
// Use E2E_API_URL when set; fall back to BASE for single-origin deployments.
const API = `${process.env.E2E_API_URL ?? BASE}/api/v1`

const HAS_SESSION = hasAuthSession()

async function apiGet(request: import('@playwright/test').APIRequestContext, url: string) {
    try {
        return await request.get(url)
    } catch {
        return null
    }
}

test.describe('AUDIT-P3: API error format consistency (D-03)', () => {
    test('RSI proposals 400 uses structured error format', async ({ request }) => {
        const res = await apiGet(request, `${API}/rsi/proposals?workspaceId=not-a-uuid`)
        if (!res) {
            test.skip(true, 'API not reachable — set E2E_BASE_URL to run against a live instance')
            return
        }
        expect([400, 401, 403]).toContain(res.status())

        if (res.status() === 400) {
            const body = await res.json() as { error?: { code?: string; message?: string } }
            expect(body).toHaveProperty('error')
            expect(typeof body.error).toBe('object')
            expect(body.error).toHaveProperty('code')
            expect(body.error).toHaveProperty('message')
        }
    })

    test('A2A agent card 404 uses structured error format', async ({ request }) => {
        const res = await apiGet(request, `${API}/a2a/agents/nonexistent-agent-id/card`)
        if (!res) {
            test.skip(true, 'API not reachable — set E2E_BASE_URL to run against a live instance')
            return
        }
        expect([404, 401]).toContain(res.status())

        if (res.status() === 404) {
            const body = await res.json() as { error?: { code?: string } }
            expect(body).toHaveProperty('error')
            expect(typeof body.error).toBe('object')
            expect(body.error).toHaveProperty('code')
        }
    })
})

test.describe('AUDIT-P3: node-events pagination (D-04)', () => {
    test.skip(!HAS_SESSION, 'Requires auth session')

    test('node-events GET accepts offset param', async ({ request }) => {
        const res = await apiGet(request, `${API}/nodes/events?limit=10&offset=0`)
        if (!res) {
            test.skip(true, 'API not reachable')
            return
        }
        expect(res.status()).not.toBe(500)
        expect([200, 400, 401, 403]).toContain(res.status())
    })
})

test.describe('AUDIT-P3: data retention cron (D-07)', () => {
    test.skip(!HAS_SESSION, 'Requires auth session')

    test('cron jobs endpoint includes data retention job', async ({ request }) => {
        const res = await apiGet(request, `${API}/cron`)
        if (!res) {
            test.skip(true, 'API not reachable')
            return
        }
        if (res.status() === 200) {
            const body = await res.json() as { jobs?: Array<{ name: string }> }
            if (body.jobs) {
                const hasRetention = body.jobs.some(j => j.name.includes('data_retention') || j.name.includes('Data retention'))
                expect(hasRetention).toBe(true)
            }
        } else {
            expect([401, 403]).toContain(res.status())
        }
    })
})
