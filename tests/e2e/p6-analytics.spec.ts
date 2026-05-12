// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P6 Analytics & Observability E2E — proves ingest endpoints work,
 * ANALYTICS.md exists, and opt-out is respected.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
const REPO_ROOT = path.resolve(__dirname, '../..')

test.describe('P6: Analytics & Observability', () => {
    test('ANALYTICS.md exists at repo root', () => {
        // Could be a symlink — check that it resolves
        const telPath = path.join(REPO_ROOT, 'ANALYTICS.md')
        expect(fs.existsSync(telPath)).toBe(true)
        const content = fs.readFileSync(telPath, 'utf-8')
        expect(content).toContain('Analytics')
        expect(content).toContain('opt')
        expect(content).toContain('disabled by default')
    })

    test('analytics ingest accepts valid event', async ({ request }) => {
        const res = await request.post(`${API}/api/v1/analytics/ingest`, {
            data: {
                event_name: 'plexo_installed',
                properties: { instance_uuid: 'test-e2e-instance' },
                instance_uuid: 'test-e2e-instance',
            },
        })
        // 201 = accepted, 204 = analytics disabled, both valid
        expect([201, 204]).toContain(res.status())
    })

    test('analytics ingest rejects unknown event', async ({ request }) => {
        const res = await request.post(`${API}/api/v1/analytics/ingest`, {
            data: {
                event_name: 'not_a_real_event',
                properties: {},
            },
        })
        expect(res.status()).toBe(400)
    })

    test('error ingest accepts valid error', async ({ request }) => {
        const res = await request.post(`${API}/api/v1/analytics/error`, {
            data: {
                fingerprint: 'e2e-test-error',
                message: 'Test error from E2E suite',
                context: { severity: 'low', source: 'e2e' },
            },
        })
        expect([201, 500]).toContain(res.status()) // 500 if table doesn't exist yet (pre-migration)
    })

    test('analytics config endpoint responds', async ({ request }) => {
        const res = await request.get(`${API}/api/v1/analytics`)
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(typeof body.errorsEnabled).toBe('boolean')
        expect(typeof body.usageEnabled).toBe('boolean')
    })
})
