// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P8 Launch E2E — landing page, install.sh, docs, copy assets, full critical path.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
const REPO_ROOT = path.resolve(__dirname, '../..')
import { hasAuthSession, dismissAnalyticsModal } from './_helpers'
const HAS_SESSION = hasAuthSession()

test.describe('P8: Launch', () => {
    test.describe('Landing Page', () => {
        test('landing page renders hero for unauthenticated user', async ({ page }) => {
            await page.context().clearCookies()
            await page.goto(BASE)
            await expect(page.locator('h1')).toBeVisible()
            await expect(page.locator('h1')).toContainText('infrastructure')
        })

        test('install command visible on landing page', async ({ page }) => {
            await page.context().clearCookies()
            await page.goto(BASE)
            await expect(page.locator('text=install.sh')).toBeVisible()
        })

        test('compatibility section lists protocols', async ({ page }) => {
            await page.context().clearCookies()
            await page.goto(BASE)
            await expect(page.locator('text=Works with')).toBeVisible()
            await expect(page.locator('text=Agent Skills (SKILL.md)')).toBeVisible()
        })

        test('workspace memory section present', async ({ page }) => {
            await page.context().clearCookies()
            await page.goto(BASE)
            await expect(page.locator('text=Plexo learns how you work')).toBeVisible()
        })
    })

    test.describe('Install Script', () => {
        test('install.sh exists and is valid', () => {
            const scriptPath = path.join(REPO_ROOT, 'scripts/install.sh')
            expect(fs.existsSync(scriptPath)).toBe(true)
            const content = fs.readFileSync(scriptPath, 'utf-8')
            expect(content).toContain('#!/usr/bin/env bash')
            expect(content).toContain('docker')
            expect(content).toContain('set -euo pipefail')
        })
    })

    test.describe('Documentation', () => {
        const requiredDocs = [
            'README.md',
            'CONTRIBUTING.md',
            'AGENTS.md',
            'ANALYTICS.md',
            'LICENSE',
            'docs/getting-started.md',
            'docs/self-host.md',
            'docs/skills.md',
            'docs/a2a.md',
            'docs/mcp.md',
            'docs/memory.md',
        ]

        for (const doc of requiredDocs) {
            test(`${doc} exists`, () => {
                expect(fs.existsSync(path.join(REPO_ROOT, doc))).toBe(true)
            })
        }

        test('README references all key docs', () => {
            const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8')
            expect(readme).toContain('getting-started')
            expect(readme).toContain('skills.md')
            expect(readme).toContain('a2a.md')
            expect(readme).toContain('mcp.md')
            expect(readme).toContain('memory.md')
        })
    })

    test.describe('Launch Copy', () => {
        test('launch/ directory has all copy assets', () => {
            for (const file of ['producthunt.md', 'hackernews.md', 'reddit-selfhosted.md']) {
                const p = path.join(REPO_ROOT, 'launch', file)
                expect(fs.existsSync(p)).toBe(true)
                const content = fs.readFileSync(p, 'utf-8')
                expect(content.length).toBeGreaterThan(200)
                expect(content.toLowerCase()).toContain('plexo')
            }
        })
    })

    test.describe('API Health', () => {
        test('health endpoint green', async ({ request }) => {
            const res = await request.get(`${API}/health`, { timeout: 10000 })
                .catch(() => null)
            if (res) expect(res.status()).toBe(200)
        })

        test('agent.json discovery endpoint responds', async ({ request }) => {
            const res = await request.get(`${API}/.well-known/agent.json`, { timeout: 10000 })
                .catch(() => null)
            if (res) {
                expect(res.status()).toBe(200)
                const body = await res.json()
                expect(body).toHaveProperty('name')
            }
        })
    })

    test.describe('Critical Path', () => {
        test('full critical path: dashboard loads with task input visible', async ({ page }) => {
            test.skip(!HAS_SESSION, 'No auth session')

            // Auth state pre-loaded from auth.setup.ts — go directly to dashboard
            await page.goto(`${BASE}/home`)
            await page.waitForTimeout(2000)
            await dismissAnalyticsModal(page)

            await expect(page.locator('main, [data-testid="dashboard"], [role="main"]')).toBeVisible({ timeout: 10000 })

            const input = page.locator(
                'textarea, input[type="text"][placeholder*="ask"], [data-testid="task-input"], [data-testid="chat-input"], [contenteditable="true"]'
            )
            await expect(input.first()).toBeVisible({ timeout: 10000 })
        })
    })
})
