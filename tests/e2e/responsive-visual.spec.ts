// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Visual-regression baselines (QA-opt FE7, ADR 0040). Runs under the
 * `mobile-390` and `desktop-1440` projects (see playwright.config.ts), so each
 * route is snapshotted once per operator-standard viewport. Dynamic regions are
 * masked (see VISUAL_MASK_SELECTORS).
 *
 * Generate/refresh baselines (only after a reviewed UI change):
 *   E2E_BASE_URL=https://app.getplexo.com E2E_EMAIL=… E2E_PASSWORD=… \
 *     pnpm playwright test responsive-visual --update-snapshots
 * Baselines live in tests/e2e/__screenshots__/ and are committed.
 */
import { test, expect } from '@playwright/test'
import { ROUTES, VISUAL_MASK_SELECTORS } from './_helpers/routes'

for (const route of ROUTES) {
    test(`visual: ${route.id}`, async ({ page }) => {
        await page.goto(route.path)

        // Authed route but no session (empty auth state) → bounced to login. Skip
        // rather than baseline a login page under an authed route's name.
        if (route.auth && /\/login|\/signin/.test(new URL(page.url()).pathname)) {
            test.skip(true, 'no authenticated session — set E2E_EMAIL/E2E_PASSWORD')
        }

        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {})

        const mask = VISUAL_MASK_SELECTORS.map(sel => page.locator(sel))
        await expect(page).toHaveScreenshot(`${route.id}.png`, {
            fullPage: true,
            mask,
        })
    })
}
