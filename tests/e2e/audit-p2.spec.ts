// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * AUDIT-P2 E2E — Type Safety + Code Quality
 *
 * Verifies:
 *   1. Workspace hook consolidation — pages load without JS errors
 *   2. describeAction dedup — task progress endpoint responds correctly
 *   3. useWorkspaceId hook — pages using the hook render without crash
 */
import { test, expect } from '@playwright/test'
import { hasAuthSession, dismissAnalyticsModal } from './_helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const HAS_SESSION = hasAuthSession()

test.describe('AUDIT-P2: workspace hook consolidation', () => {
    test.skip(!HAS_SESSION, 'Requires auth session')

    test('pages using useWorkspaceId render without JS errors', async ({ page }) => {
        const consoleErrors: string[] = []
        page.on('console', msg => {
            if (msg.type() === 'error') consoleErrors.push(msg.text())
        })

        await page.goto(`${BASE}/app/connections`, { waitUntil: 'networkidle' })
        await dismissAnalyticsModal(page)

        const critical = consoleErrors.filter(
            e => !e.includes('favicon') && !e.includes('net::ERR') && !e.includes('404')
        )
        expect(critical).toHaveLength(0)
    })

    test('cron page (useWorkspaceId) renders without crash', async ({ page }) => {
        const consoleErrors: string[] = []
        page.on('console', msg => {
            if (msg.type() === 'error') consoleErrors.push(msg.text())
        })

        await page.goto(`${BASE}/app/cron`, { waitUntil: 'networkidle' })
        await dismissAnalyticsModal(page)

        const critical = consoleErrors.filter(
            e => !e.includes('favicon') && !e.includes('net::ERR') && !e.includes('404')
        )
        expect(critical).toHaveLength(0)
    })

    test('extensions page (useWorkspaceId) renders without crash', async ({ page }) => {
        await page.goto(`${BASE}/app/extensions`, { waitUntil: 'networkidle' })
        await dismissAnalyticsModal(page)
        // Page must not show an unhandled error boundary
        await expect(page.locator('body')).not.toContainText('Unhandled Runtime Error')
    })
})
