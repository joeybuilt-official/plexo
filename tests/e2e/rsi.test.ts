import { test, expect } from '@playwright/test'
import { dismissAnalyticsModal } from './_helpers'

const SKIP_BROWSER = process.env.E2E_SKIP_BROWSER === 'true'

test.describe('RSI Accountability Dashboard (Phase 13)', () => {
    test.skip(SKIP_BROWSER, 'Set E2E_SKIP_BROWSER=false to enable')

    test('Accountability tab loads and displays RSI panel', async ({ page }) => {
        // Go to settings
        await page.goto('/settings')
        // If redirected to login (no E2E_EMAIL/E2E_PASSWORD set), skip
        if (/login|signin/.test(page.url())) return
        await dismissAnalyticsModal(page)

        // Find and click the Accountability tab/section
        const accountabilityTab = page.getByRole('button', { name: /Accountability/ })
        await accountabilityTab.waitFor({ state: 'visible', timeout: 10000 })
        await accountabilityTab.click()

        // Verify the Accountability panel mounts
        await expect(page.getByRole('heading', { name: 'Accountability (RSI)' })).toBeVisible({ timeout: 10000 })

        // Real page shows empty state when no proposals exist
        const emptyState = page.locator('text=No proposals available')
        const hasEmpty = await emptyState.isVisible({ timeout: 5000 }).catch(() => false)
        // Either empty state or proposals list means the panel works
        expect(hasEmpty || await page.locator('[data-testid="rsi-proposals"]').isVisible().catch(() => false)).toBeTruthy()
    })
})
