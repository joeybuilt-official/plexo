// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P7 Launch Readiness E2E — full critical path:
 * login → dashboard → submit task input visible → health ok
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
import { hasAuthSession } from './_helpers'
const HAS_SESSION = hasAuthSession()
const REPO_ROOT = path.resolve(__dirname, '../..')

test.describe('P7: Launch Readiness', () => {
    test('README.md exists and tells the story', () => {
        const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8')
        expect(readme.length).toBeGreaterThan(500)
        expect(readme.toLowerCase()).toContain('plexo')
        expect(readme.toLowerCase()).toContain('install')
    })

    test('CONTRIBUTING.md exists', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, 'CONTRIBUTING.md'))).toBe(true)
    })

    test('AGENTS.md exists', () => {
        expect(fs.existsSync(path.join(REPO_ROOT, 'AGENTS.md'))).toBe(true)
    })

    test('ANALYTICS.md accessible at root', () => {
        const telPath = path.join(REPO_ROOT, 'ANALYTICS.md')
        expect(fs.existsSync(telPath)).toBe(true)
    })

    test('LICENSE file exists', () => {
        const licensePath = path.join(REPO_ROOT, 'LICENSE')
        expect(fs.existsSync(licensePath)).toBe(true)
    })

    test('health endpoint green', async ({ request }) => {
        const res = await request.get(`${API}/health`)
        expect(res.status()).toBe(200)
    })

    test('full critical path: login → dashboard → task input visible', async ({ page }) => {
        test.skip(!HAS_SESSION, 'No auth session')

        // Login
        await page.goto(`${BASE}/login`)
        await page.fill('input[type="email"], input[name="email"]', process.env.E2E_EMAIL!)
        await page.fill('input[type="password"]', process.env.E2E_PASSWORD!)
        await page.click('button[type="submit"]')
        await page.waitForURL((url) => !/login|signin/.test(url.pathname), { timeout: 15000 })

        // Dashboard visible
        await expect(page.locator('main, [data-testid="dashboard"], [role="main"]')).toBeVisible({ timeout: 10000 })

        // Task input visible (the core user action)
        const input = page.locator(
            'textarea, input[type="text"][placeholder*="ask"], [data-testid="task-input"], [data-testid="chat-input"], [contenteditable="true"]'
        )
        await expect(input.first()).toBeVisible({ timeout: 10000 })
    })
})
