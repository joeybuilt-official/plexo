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
    // Visual-regression + a11y specs run at BOTH operator-standard viewports
    // (mobile 390, desktop 1440) under dedicated projects; functional specs stay
    // desktop-only on `chromium`. Match by filename so each spec runs once per
    // viewport, not 3×.
    snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{projectName}-{arg}{ext}',
    expect: {
        // Streaming/agent panels + relative timestamps are masked in the specs;
        // this ratio absorbs sub-pixel font AA differences across runs.
        toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
    },
    projects: [
        // Auth setup — runs first, saves session state
        {
            name: 'setup',
            testMatch: /auth\.setup\.ts/,
        },
        // Functional E2E — desktop, excludes the viewport-matrix specs
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                storageState: AUTH_FILE,
            },
            testIgnore: [/responsive-visual\.spec\.ts/, /a11y\.spec\.ts/],
            dependencies: ['setup'],
        },
        // Visual + a11y @ mobile 390 (operator standard)
        {
            name: 'mobile-390',
            testMatch: [/responsive-visual\.spec\.ts/, /a11y\.spec\.ts/],
            use: {
                ...devices['Pixel 7'],
                viewport: { width: 390, height: 844 },
                storageState: AUTH_FILE,
            },
            dependencies: ['setup'],
        },
        // Visual + a11y @ desktop 1440 (operator standard)
        {
            name: 'desktop-1440',
            testMatch: [/responsive-visual\.spec\.ts/, /a11y\.spec\.ts/],
            use: {
                ...devices['Desktop Chrome'],
                viewport: { width: 1440, height: 900 },
                storageState: AUTH_FILE,
            },
            dependencies: ['setup'],
        },
    ],
    // Don't auto-start dev server — we assume stack is already running for E2E
})
