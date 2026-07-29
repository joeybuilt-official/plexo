// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import fs from 'node:fs'
import path from 'node:path'

const AUTH_FILE = path.join('tests', '.auth', 'user.json')

/**
 * Check if the saved auth state has a valid session.
 * Returns false if auth setup failed (user doesn't exist in local DB).
 */
export function hasAuthSession(): boolean {
    try {
        const data = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8'))
        return (data.cookies?.length ?? 0) > 0
    } catch {
        return false
    }
}

/**
 * Dismiss the analytics preview modal if it's blocking the page.
 * Call this after navigating to any authenticated page.
 */
export async function dismissAnalyticsModal(page: import('@playwright/test').Page): Promise<void> {
    const modal = page.locator('[data-testid="analytics-modal"]')
    if (await modal.isVisible({ timeout: 2000 }).catch(() => false)) {
        await page.locator('[data-testid="analytics-confirm"]').click({ force: true })
        await modal.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
    }
}
