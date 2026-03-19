// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Page } from 'playwright'
import type { Persona } from './index.js'
import { loginIfNeeded } from '../utils/login.js'

// Sidebar nav items live inside <aside> on desktop. Using direct URL navigation
// is more reliable than clicking sidebar links (which are hidden on mobile and
// can cause strict-mode violations when the mobile bottom-nav is also in DOM).
async function navTo(page: Page, href: string) {
    await page.goto(href)
    await page.waitForTimeout(500)
}

export const powerUser: Persona = {
    id: 'power-user',
    name: 'Power User (Multi-Tasker)',
    description: 'A dedicated user creating tasks and projects across multiple screens.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        await page.waitForTimeout(1000)

        await session.logEvent('navigating_to_tasks', {})
        await navTo(page, '/tasks')
        await page.waitForSelector('[id^="task-row-"]', { timeout: 10000 }).catch(() => {})
        await session.logEvent('viewed_tasks_list', {})

        await session.logEvent('navigating_to_projects', {})
        await navTo(page, '/projects')
        await page.waitForSelector('[id^="project-card-"]', { timeout: 10000 }).catch(() => {})
        await session.logEvent('viewed_projects_list', {})

        await navTo(page, '/chat')
        await page.waitForSelector('textarea')
        await page.fill('textarea', 'Let us plan a new marketing campaign for Discord launch.')
        await page.click('#send-btn')
        await session.logEvent('sent_complex_prompt', { content: 'Let us plan a new marketing campaign for Discord launch.' })

        // Wait for confirmation button OR automatic execution (textarea becomes enabled again)
        await page.waitForSelector('button:has-text("Create Project"), textarea:not([disabled])', { timeout: 45000 })
        const btn = await page.locator('button:has-text("Create Project")').isVisible()
        if (btn) {
            await page.click('button:has-text("Create Project")')
            await session.logEvent('clicked_create_project_confirm', {})
        } else {
            await session.logEvent('project_automatically_queued', {})
        }
    }
}
