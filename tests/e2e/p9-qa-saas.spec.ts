// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P9 QA SaaS E2E — simulates real user flows against the live SaaS.
 *
 * Run with: E2E_BASE_URL=https://getplexo.com npx playwright test tests/e2e/p9-qa-saas.spec.ts
 *
 * Flows covered:
 *   1. Login page loads, form renders, no console errors
 *   2. Landing/marketing page renders key elements
 *   3. /app redirects to /login when unauthenticated
 *   4. /health returns 200 with valid JSON
 *   5. /api/v1/metrics returns data or 401 (never 500)
 *   6. Chat page structure loads after auth
 *   7. Settings pages render without blank screens
 */
import { test, expect, type ConsoleMessage } from '@playwright/test'
import { hasAuthSession, dismissAnalyticsModal } from './_helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const HAS_SESSION = hasAuthSession()

// ─── 1. Login page ────────────────────────────────────────────────────────────
test.describe('Flow 1: Login page', () => {
    test('login page loads and form renders', async ({ page }) => {
        // Clear any saved session so we test the unauthenticated view
        await page.context().clearCookies()

        const consoleErrors: string[] = []
        page.on('console', (msg: ConsoleMessage) => {
            if (msg.type() === 'error') consoleErrors.push(msg.text())
        })

        await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })

        // Email and password fields must be visible
        await expect(
            page.locator('input[type="email"], input[name="email"]').first()
        ).toBeVisible({ timeout: 10000 })
        await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 10000 })

        // Submit button must be present
        await expect(page.locator('button[type="submit"]').first()).toBeVisible({ timeout: 5000 })

        // No JS console errors on load (informational — logged if any)
        const criticalErrors = consoleErrors.filter(
            e =>
                !e.includes('favicon') &&
                !e.includes('net::ERR') &&
                !e.includes('Failed to load resource') &&
                !e.includes('404')
        )
        if (criticalErrors.length > 0) {
            console.warn('Console errors on login page:', criticalErrors)
        }
        expect(criticalErrors.length).toBe(0)
    })

    test('login page title is set', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(`${BASE}/login`)
        const title = await page.title()
        expect(title.length).toBeGreaterThan(0)
        expect(title.toLowerCase()).toMatch(/plexo|login|sign in/)
    })
})

// ─── 2. Landing / marketing page ─────────────────────────────────────────────
test.describe('Flow 2: Landing page', () => {
    test('landing page renders hero heading', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(BASE, { waitUntil: 'networkidle' })

        const h1 = page.locator('h1').first()
        await expect(h1).toBeVisible({ timeout: 10000 })
        const h1Text = await h1.textContent()
        expect((h1Text ?? '').length).toBeGreaterThan(5)
    })

    test('landing page has a CTA button or link', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(BASE, { waitUntil: 'networkidle' })

        // Should have at least one visible call-to-action
        const cta = page.locator(
            'a[href*="login"], a[href*="signup"], a[href*="register"], button:has-text("Get started"), button:has-text("Sign up"), a:has-text("Get started"), a:has-text("Sign up")'
        )
        await expect(cta.first()).toBeVisible({ timeout: 10000 })
    })

    test('landing page has navigation', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(BASE, { waitUntil: 'networkidle' })

        const nav = page.locator('nav, header').first()
        await expect(nav).toBeVisible({ timeout: 10000 })
    })

    test('landing page does not show blank white screen', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(BASE, { waitUntil: 'networkidle' })

        // Body must have visible text content
        const bodyText = await page.locator('body').textContent()
        expect((bodyText ?? '').trim().length).toBeGreaterThan(50)
    })
})

// ─── 3. /app unauthenticated redirect ────────────────────────────────────────
test.describe('Flow 3: Unauthenticated redirect', () => {
    test('/app redirects to login when unauthenticated', async ({ page }) => {
        // Force unauthenticated state
        await page.context().clearCookies()
        await page.context().clearPermissions()

        await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' })

        // Should end up on a login/sign-in route
        const finalUrl = page.url()
        const isRedirectedToAuth =
            /login|signin|sign-in|auth/.test(finalUrl) ||
            (await page.locator('input[type="email"], input[name="email"]').isVisible({ timeout: 5000 }).catch(() => false))

        if (!isRedirectedToAuth) {
            await page.screenshot({ path: 'playwright-report/p9-app-redirect-failure.png' })
            // Document what the user would see
            const bodyText = await page.locator('body').textContent()
            console.error(
                `FAIL: /app did not redirect to login for unauthenticated user.\n` +
                `Final URL: ${finalUrl}\n` +
                `Body preview: ${(bodyText ?? '').slice(0, 200)}`
            )
        }
        expect(isRedirectedToAuth).toBe(true)
    })

    test('/app/home redirects to login when unauthenticated', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(`${BASE}/app/home`, { waitUntil: 'networkidle' })

        const finalUrl = page.url()
        const isOnAuth =
            /login|signin|sign-in|auth/.test(finalUrl) ||
            (await page.locator('input[type="email"]').isVisible({ timeout: 5000 }).catch(() => false))

        if (!isOnAuth) {
            await page.screenshot({ path: 'playwright-report/p9-home-redirect-failure.png' })
        }
        expect(isOnAuth).toBe(true)
    })
})

// ─── 4. Health endpoints ──────────────────────────────────────────────────────
// Note: /health is a Next.js stub used by the deploy pipeline — returns {status:"ok"}.
//       /api/v1/health is the full Express API health check with service probes.
test.describe('Flow 4: Health endpoints', () => {
    test('/health (Next.js stub) returns 200 with status ok', async ({ request }) => {
        const res = await request.get(`${BASE}/health`, { timeout: 15000 })
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body).toHaveProperty('status')
        expect(body.status).toBe('ok')
    })

    test('/api/v1/health returns 200 with valid JSON shape', async ({ request }) => {
        const res = await request.get(`${BASE}/api/v1/health`, { timeout: 15000 })
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body).toHaveProperty('status')
        expect(['ok', 'degraded']).toContain(body.status)
        expect(body).toHaveProperty('services')
        expect(body.services).toHaveProperty('postgres')
        expect(body.services).toHaveProperty('redis')
        expect(body.services.postgres).toHaveProperty('ok')
        expect(body.services.redis).toHaveProperty('ok')
    })

    test('/api/v1/health services are ok (not degraded)', async ({ request }) => {
        const res = await request.get(`${BASE}/api/v1/health`, { timeout: 15000 })
        const body = await res.json()

        if (body.status !== 'ok') {
            console.error(
                `DEGRADED: /api/v1/health status is "${body.status}"\n` +
                `postgres.ok=${body.services?.postgres?.ok}, redis.ok=${body.services?.redis?.ok}`
            )
        }
        expect(body.status).toBe('ok')
        expect(body.services.postgres.ok).toBe(true)
        expect(body.services.redis.ok).toBe(true)
    })
})

// ─── 5. /api/v1/metrics ───────────────────────────────────────────────────────
test.describe('Flow 5: Metrics endpoint', () => {
    test('/api/v1/metrics responds — 200 with data or 401/403 (never 500)', async ({ request }) => {
        const res = await request.get(`${BASE}/api/v1/metrics`, { timeout: 10000 })
            .catch(() => null)

        if (!res) {
            // Network-level failure — treat as not-found, not a 500
            console.warn('/api/v1/metrics was unreachable (network error)')
            return
        }

        const status = res.status()

        if (status === 500) {
            const body = await res.text().catch(() => '')
            console.error(`FAIL: /api/v1/metrics returned 500\nBody: ${body.slice(0, 300)}`)
        }

        // Acceptable: 200 (open), 401/403 (gated), 404 (not yet routed)
        // NOT acceptable: 500
        expect(status).not.toBe(500)

        if (status === 200) {
            const text = await res.text()
            // Prometheus exposition format — should have at least one metric line
            expect(text.length).toBeGreaterThan(0)
        }
    })
})

// ─── 6. Chat page ─────────────────────────────────────────────────────────────
test.describe('Flow 6: Chat page (authenticated)', () => {
    test('chat page structure loads — input visible', async ({ page }) => {
        test.skip(!HAS_SESSION, 'No auth session — set E2E_EMAIL/E2E_PASSWORD')

        await page.goto(`${BASE}/app/chat`, { waitUntil: 'networkidle' })
        await dismissAnalyticsModal(page)

        const mainContent = page.locator('main, [role="main"], [data-testid="chat"]').first()
        await expect(mainContent).toBeVisible({ timeout: 10000 })

        // Chat input must be visible — the core user action
        const chatInput = page.locator(
            'textarea, input[type="text"], [data-testid="chat-input"], [contenteditable="true"]'
        ).first()
        await expect(chatInput).toBeVisible({ timeout: 10000 })
    })

    test('chat page does not blank-screen after load', async ({ page }) => {
        test.skip(!HAS_SESSION, 'No auth session — set E2E_EMAIL/E2E_PASSWORD')

        const jsErrors: string[] = []
        page.on('pageerror', err => jsErrors.push(err.message))

        await page.goto(`${BASE}/app/chat`, { waitUntil: 'networkidle' })
        await dismissAnalyticsModal(page)

        // Page must have rendered visible content
        const bodyText = await page.locator('body').textContent()
        expect((bodyText ?? '').trim().length).toBeGreaterThan(20)

        if (jsErrors.length > 0) {
            await page.screenshot({ path: 'playwright-report/p9-chat-js-errors.png' })
            console.error('JS errors on chat page:', jsErrors)
            expect(jsErrors.length).toBe(0)
        }
    })
})

// ─── 7. Settings pages ────────────────────────────────────────────────────────
test.describe('Flow 7: Settings pages (authenticated)', () => {
    const settingsRoutes = [
        { path: '/app/settings', name: 'Settings root' },
        { path: '/app/settings/intelligence', name: 'Intelligence settings' },
        { path: '/app/settings/channels', name: 'Channels settings' },
        { path: '/app/settings/behavior', name: 'Behavior settings' },
        { path: '/app/settings/users', name: 'Users settings' },
    ]

    for (const { path, name } of settingsRoutes) {
        test(`${name} renders without blank screen`, async ({ page }) => {
            test.skip(!HAS_SESSION, 'No auth session — set E2E_EMAIL/E2E_PASSWORD')

            const jsErrors: string[] = []
            page.on('pageerror', err => jsErrors.push(err.message))

            // domcontentloaded (not networkidle): authed pages hold SSE/polling
            // connections that never let the network go idle → 30s goto timeout.
            await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
            await dismissAnalyticsModal(page)

            // Must not be a blank/empty page
            const bodyText = await page.locator('body').textContent()
            if ((bodyText ?? '').trim().length < 20) {
                await page.screenshot({ path: `playwright-report/p9-settings-blank-${path.replace(/\//g, '-')}.png` })
                console.error(`BLANK SCREEN: ${name} (${BASE}${path})`)
            }
            expect((bodyText ?? '').trim().length).toBeGreaterThan(20)

            // Main content area must render
            const mainContent = page.locator('main, [role="main"]').first()
            await expect(mainContent).toBeVisible({ timeout: 10000 })

            if (jsErrors.length > 0) {
                await page.screenshot({ path: `playwright-report/p9-settings-jserr-${path.replace(/\//g, '-')}.png` })
                console.error(`JS errors on ${name}:`, jsErrors)
                expect(jsErrors.length).toBe(0)
            }
        })
    }
})

// ─── 8. Signup page ───────────────────────────────────────────────────────────
test.describe('Flow 8: Signup page', () => {
    test('signup page renders registration form', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' })

        // Name, email, password fields must all be present
        await expect(page.locator('input[type="text"][id="register-name"], input[name="name"]').first()).toBeVisible({ timeout: 10000 })
        await expect(page.locator('input[type="email"]').first()).toBeVisible({ timeout: 10000 })
        await expect(page.locator('input[type="password"]').first()).toBeVisible({ timeout: 10000 })
        await expect(page.locator('button[type="submit"]').first()).toBeVisible({ timeout: 5000 })
    })

    test('signup page has Google SSO button', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' })

        const googleBtn = page.locator('button:has-text("Google"), button:has-text("Continue with Google")')
        await expect(googleBtn.first()).toBeVisible({ timeout: 10000 })
    })

    test('signup page links back to login', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' })

        const loginLink = page.locator('a[href="/login"], a:has-text("Sign in"), a:has-text("Log in")')
        await expect(loginLink.first()).toBeVisible({ timeout: 10000 })
    })

    test('signup form labels are accessible', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(`${BASE}/signup`, { waitUntil: 'networkidle' })

        // Each field must have an associated label (for= or aria-label)
        const emailInput = page.locator('input[type="email"]').first()
        const emailId = await emailInput.getAttribute('id')
        const emailAriaLabel = await emailInput.getAttribute('aria-label')
        const hasEmailLabel = emailAriaLabel ||
            (emailId ? await page.locator(`label[for="${emailId}"]`).count() > 0 : false)
        expect(hasEmailLabel).toBeTruthy()
    })
})

// ─── 9. 404 / unknown routes ──────────────────────────────────────────────────
test.describe('Flow 9: 404 error handling', () => {
    test('unknown route renders 404 page with error message', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(`${BASE}/this-route-definitely-does-not-exist-xyz`, { waitUntil: 'networkidle' })

        // Should show 404 content — either as text or in an element
        const bodyText = (await page.locator('body').textContent()) ?? ''
        const has404 = bodyText.includes('404') || bodyText.toLowerCase().includes('not found')

        if (!has404) {
            await page.screenshot({ path: 'playwright-report/p9-404-missing.png' })
            console.error('404 page missing expected content. Body preview:', bodyText.slice(0, 200))
        }
        expect(has404).toBe(true)
    })

    test('unknown route does not return blank screen', async ({ page }) => {
        await page.context().clearCookies()
        const res = await page.goto(`${BASE}/this-route-definitely-does-not-exist-xyz`)

        // Next.js 404 renders content — body must not be empty
        const bodyText = (await page.locator('body').textContent()) ?? ''
        expect(bodyText.trim().length).toBeGreaterThan(10)
    })

    test('unknown /app/* sub-route redirects to login (not 404) when unauthenticated', async ({ page }) => {
        await page.context().clearCookies()
        await page.goto(`${BASE}/app/nonexistent-page-xyz`, { waitUntil: 'networkidle' })

        const finalUrl = page.url()
        const isOnAuth =
            /login|signin|sign-in|auth/.test(finalUrl) ||
            (await page.locator('input[type="email"]').isVisible({ timeout: 5000 }).catch(() => false))

        if (!isOnAuth) {
            await page.screenshot({ path: 'playwright-report/p9-app-subroute-redirect.png' })
        }
        expect(isOnAuth).toBe(true)
    })
})

// ─── 10. Additional protected route redirects ─────────────────────────────────
test.describe('Flow 10: Protected route guards', () => {
    const protectedRoutes = [
        '/app/chat',
        '/app/tasks',
        '/app/settings',
        '/app/settings/intelligence',
    ]

    for (const path of protectedRoutes) {
        test(`${path} redirects to login when unauthenticated`, async ({ page }) => {
            await page.context().clearCookies()
            await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })

            const finalUrl = page.url()
            const isOnAuth =
                /login|signin|sign-in|auth/.test(finalUrl) ||
                (await page.locator('input[type="email"]').isVisible({ timeout: 5000 }).catch(() => false))

            if (!isOnAuth) {
                await page.screenshot({ path: `playwright-report/p9-guard-${path.replace(/\//g, '-')}.png` })
                console.error(`FAIL: ${path} did not redirect unauthenticated user to login. Final URL: ${finalUrl}`)
            }
            expect(isOnAuth).toBe(true)
        })
    }
})
