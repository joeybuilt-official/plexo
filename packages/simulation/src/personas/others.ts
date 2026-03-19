// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Persona } from './index.js'
import { loginIfNeeded } from '../utils/login.js'

export const chattyCathy: Persona = {
    id: 'chatty-cathy',
    name: 'Chatty Cathy',
    description: 'Long conversation without task creation.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        await page.goto('/chat')
        await session.logEvent('chat_started', {})
        
        const messages = [
            'Tell me a joke about AI and coffee.',
            'That was funny. What about a dark one?',
            'How do I make the perfect espresso?',
            'What about the history of coffee in Africa?'
        ]

        for (const msg of messages) {
            await page.waitForSelector('textarea:not([disabled])', { timeout: 45000 })
            await page.fill('textarea', msg)
            await page.click('#send-btn')
            await session.logEvent('sent_chat_message', { content: msg })
            await page.waitForSelector('textarea:not([disabled])', { timeout: 45000 })
            await page.waitForTimeout(1000)
        }
        await session.logEvent('long_conversation_completed', {})
    }
}

export const taskMachine: Persona = {
    id: 'task-machine',
    name: 'Task Machine',
    description: 'Rapid-fire task creation to test handling.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        await page.goto('/chat')
        const prompts = [
            'Create a task to buy groceries',
            'Create a task to walk the dog',
            'Create a task to check the server status'
        ]

        for (const msg of prompts) {
            await page.waitForSelector('textarea:not([disabled])', { timeout: 30000 })
            await page.fill('textarea', msg)
            await page.click('#send-btn')
            await session.logEvent('sent_task_creation_prompt', { content: msg })
            await page.waitForSelector('textarea:not([disabled])', { timeout: 30000 })
            await page.waitForTimeout(2000)
        }
        await session.logEvent('task_spam_completed', {})
    }
}

export const securityScout: Persona = {
    id: 'security-scout',
    name: 'Security Scout',
    description: 'Attempts to navigate to unauthorized routes or handle malformed requests.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        
        const routes = ['/api/v1/auth/admin', '/debug', '/settings/users', '/non-existent-route']
        for (const route of routes) {
            await session.logEvent('trying_route', { route })
            try {
                await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 10000 })
            } catch {
                await session.logEvent('route_navigation_timeout', { route })
                continue
            }
            await page.waitForTimeout(300)
            const is404 = await page.getByText(/404|Not Found/i).isVisible()
            const isDenied = await page.getByText(/Access Denied|Unauthorized/i).isVisible()
            await session.logEvent('route_result', { route, is404, isDenied })
        }
    }
}

export const managerMark: Persona = {
    id: 'manager-mark',
    name: 'Manager Mark',
    description: 'Checks logs, stats, and audit trails.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        await page.goto('/settings/intelligence')
        await session.logEvent('checking_intelligence_stats', {})
        await page.waitForSelector('[id^="provider-stat-"]', { timeout: 10000 }).catch(() => {})
        
        await page.goto('/logs')
        await session.logEvent('checking_audit_logs', {})
        await page.waitForSelector('[id^="log-row-"]', { timeout: 10000 }).catch(() => {})
        
        await page.goto('/')
        await session.logEvent('viewing_dashboard_summary', {})
    }
}

export const darkModeDave: Persona = {
    id: 'dark-mode-dave',
    name: 'Dark Mode Dave',
    description: 'Toggles between light and dark mode.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        await session.logEvent('toggling_theme_start', {})
        
        const toggle = page.locator('#theme-toggle:visible')
        if (await toggle.count() > 0 && await toggle.isVisible()) {
            await toggle.click()
            await session.logEvent('clicked_theme_toggle_light', {})
            await page.waitForTimeout(500)
            await toggle.click()
            await session.logEvent('clicked_theme_toggle_dark', {})
        } else {
            await session.logEvent('theme_toggle_not_visible', {})
        }
    }
}

export const collaborator: Persona = {
    id: 'collaborator',
    name: 'Collaborator',
    description: 'Switches between multiple workspaces.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        const switcher = page.locator('aside #workspace-switcher')
        if (await switcher.count() > 0) {
            await switcher.click()
        } else {
            // Fallback: first visible instance
            await page.locator('#workspace-switcher').first().click()
        }
        await session.logEvent('workspace_switcher_opened', {})
        
        await page.waitForSelector('button:has-text("Workspace")', { timeout: 10000 }).catch(() => {})
        const items = await page.locator('button:has-text("Workspace")').count()
        await session.logEvent('workspace_items_count', { count: items })
        
        if (items > 1) {
            await page.locator('button:has-text("Workspace")').nth(1).click()
            await session.logEvent('switched_workspace', {})
        }
    }
}

export const errorHunter: Persona = {
    id: 'error-hunter',
    name: 'Error Hunter',
    description: 'Triggers intentional error paths to verify error boundary performance.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        await page.goto('/debug?trigger=client-error') // Hypothetical debug trigger
        await session.logEvent('triggering_intentional_client_error', {})
        
        await page.waitForTimeout(1000)
        const errorBoundary = await page.getByText(/We encountered a problem/i).isVisible()
        await session.logEvent('error_boundary_detected', { success: errorBoundary })
    }
}
