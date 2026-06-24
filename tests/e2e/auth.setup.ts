/**
 * Auth setup — produces the session storageState reused by browser tests.
 *
 * Two paths, in priority order:
 *  1. E2E_SESSION_COOKIE — a pre-provisioned better-auth session token (the
 *     `__Secure-better-auth.session_token` value). Written straight into the
 *     storageState, no login flow. This is the preferred CI path: provision a
 *     long-lived QA session token as a secret, no password ever enters CI.
 *     E2E_COOKIE_DOMAIN overrides the cookie domain (defaults to the
 *     E2E_BASE_URL host).
 *  2. E2E_EMAIL / E2E_PASSWORD — interactive login fallback.
 *
 * If neither is set (or login fails), an empty state is saved and browser tests
 * gracefully skip authenticated-only assertions.
 */
import { test as setup } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const EMAIL = process.env.E2E_EMAIL
const PASSWORD = process.env.E2E_PASSWORD
const SESSION_COOKIE = process.env.E2E_SESSION_COOKIE
const AUTH_FILE = path.join('tests', '.auth', 'user.json')

function writeEmptyState(): void {
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true })
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ cookies: [], origins: [] }))
}

setup('authenticate', async ({ page, baseURL }) => {
    // Increase timeout for this setup step — login + redirect + networkidle
    setup.setTimeout(60000)

    // Path 1 — inject a pre-provisioned session token, no login flow.
    if (SESSION_COOKIE) {
        const base = process.env.E2E_BASE_URL ?? baseURL ?? 'https://app.getplexo.com'
        const host = process.env.E2E_COOKIE_DOMAIN ?? new URL(base).hostname
        const secure = base.startsWith('https')
        fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true })
        fs.writeFileSync(AUTH_FILE, JSON.stringify({
            cookies: [{
                name: '__Secure-better-auth.session_token',
                value: SESSION_COOKIE,
                domain: host,
                path: '/',
                expires: -1,
                httpOnly: true,
                secure,
                sameSite: 'Lax',
            }],
            origins: [{
                origin: base,
                localStorage: [
                    { name: 'plexo_analytics_ack', value: 'opted-in' },
                    { name: 'plexo:cookie-consent', value: 'accepted' },
                ],
            }],
        }))
        return
    }

    if (!EMAIL || !PASSWORD) {
        writeEmptyState()
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
        writeEmptyState()
    }
})
