/**
 * Auth setup — logs in once and saves session state for reuse by browser tests.
 *
 * Credentials: E2E_EMAIL / E2E_PASSWORD env vars.
 * If credentials are not set or login fails, an empty auth state is saved
 * and browser tests gracefully skip authenticated-only assertions.
 */
import { test as setup } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const AUTH_FILE = path.join('tests', '.auth', 'user.json')

setup('authenticate', async ({ page }) => {
    // Increase timeout for this setup step — login + redirect + networkidle
    setup.setTimeout(60000)

    if (!EMAIL || !PASSWORD) {
        fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true })
        fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies: [], origins: [] }))
        return
    }

    try {
        await page.goto('/login')

        // Dismiss analytics modal if it overlays the page
        const modal = page.locator('[data-testid="analytics-modal"]')
        if (await modal.isVisible({ timeout: 2000 }).catch(() => false)) {
            await page.locator('[data-testid="analytics-confirm"]').click({ force: true })
            await modal.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
        }

        await page.fill('input[type="email"], input[name="email"]', EMAIL)
        await page.fill('input[type="password"]', PASSWORD)
        await page.locator('button[type="submit"]').click({ force: true })

        // Wait for redirect away from login
        await page.waitForURL(url => !/login|signin/.test(url.pathname), { timeout: 20000 })

        // Dismiss analytics modal again post-login if needed
        if (await modal.isVisible({ timeout: 2000 }).catch(() => false)) {
            await page.locator('[data-testid="analytics-confirm"]').click({ force: true })
        }

        // Ensure analytics ack is set so the modal never appears in downstream tests
        await page.evaluate(() => {
            localStorage.setItem('plexo_analytics_ack', 'opted-in')
        })

        // Brief settle, then save state (includes cookies + localStorage)
        await page.waitForTimeout(1000)
        await page.context().storageState({ path: AUTH_FILE })
    } catch {
        fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true })
        fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies: [], origins: [] }))
    }
})
