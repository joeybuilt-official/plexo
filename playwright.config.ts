import { defineConfig, devices } from '@playwright/test'

const AUTH_FILE = './tests/.auth/user.json'

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false, // sequential — single local browser, no flakiness from race
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
    use: {
        baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
        // Send an Origin header on all requests (incl. the `request` API fixture).
        // The API's CSRF guard rejects cookie-authenticated mutations that lack
        // an Origin/Referer with 403 CSRF_MISSING_ORIGIN; real browsers always
        // send one, so without this the API-contract specs 403 before reaching
        // validation. Mirrors baseURL so it matches BETTER_AUTH_TRUSTED_ORIGINS.
        extraHTTPHeaders: {
            Origin: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
        },
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },
    projects: [
        // Auth setup — runs first, saves session state
        {
            name: 'setup',
            testMatch: /auth\.setup\.ts/,
        },
        // All E2E tests — use saved auth state for browser tests
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                storageState: AUTH_FILE,
            },
            dependencies: ['setup'],
        },
    ],
    // Don't auto-start dev server — we assume stack is already running for E2E
})
