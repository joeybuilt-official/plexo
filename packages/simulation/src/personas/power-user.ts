// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Page } from 'playwright'
import { SimulationSession } from '../session.js'
import { Persona } from './index.js'
import { loginIfNeeded } from '../utils/login.js'

export const powerUser: Persona = {
    id: 'power-user',
    name: 'Power User (Multi-Tasker)',
    description: 'A dedicated user creating tasks and projects across multiple screens.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        await page.waitForTimeout(1000)
        
        await session.logEvent('expanding_control_section', {})
        // Check if Control is visible, if not expand it. Header is uppercase "CONTROL"
        const controlVisible = await page.locator('nav a:has-text("Tasks")').isVisible()
        if (!controlVisible) {
            await page.click('div:has-text("CONTROL")')
        }
        
        await session.logEvent('navigating_to_tasks', {})
        await page.click('nav a:has-text("Tasks")')
        await page.waitForSelector('[id^="task-row-"]', { timeout: 10000 }).catch(() => {})
        await session.logEvent('viewed_tasks_list', {})
        
        await session.logEvent('navigating_to_projects', {})
        const projectsVisible = await page.locator('nav a:has-text("Projects")').isVisible()
        if (!projectsVisible) {
            await page.click('div:has-text("CONTROL")')
        }
        await page.click('nav a:has-text("Projects")')
        await page.waitForSelector('[id^="project-card-"]', { timeout: 10000 }).catch(() => {})
        await session.logEvent('viewed_projects_list', {})
        
        // Go back to chat to trigger a coordinated action
        await page.click('nav a:has-text("Chat")')
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
