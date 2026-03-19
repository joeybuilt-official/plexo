// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Persona } from './index.js'
import { loginIfNeeded } from '../utils/login.js'

export const newUser: Persona = {
    id: 'new-user',
    name: 'New User (Onboarding)',
    description: 'A new user that completes the onboarding flow and checks the dashboard.',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        
        await session.logEvent('navigating_to_onboarding', {})
        await page.goto('/onboarding?step=1')
        await page.waitForTimeout(500)
        
        await page.goto('/')

        if (page.url().includes('/setup')) {
            await session.logEvent('hit_setup_unexpectedly_in_persona', { url: page.url() })
            await page.goto('/')
        }
        
        try {
            await page.waitForSelector('[id^="dashboard-card-"]', { timeout: 30000 })
        } catch (e) {
            await session.logEvent('dashboard_cards_not_found', { url: page.url(), title: await page.title() })
            throw e
        }
        await session.logEvent('viewed_dashboard_overview', { url: page.url() })

        await page.click('nav a:has-text("Chat")')
        await page.waitForSelector('textarea')
        await session.logEvent('entered_chat', {})
        
        await page.fill('textarea', 'Hello, who are you?')
        await page.click('#send-btn')
        await session.logEvent('sent_first_message', { content: 'Hello, who are you?' })
        
        await page.waitForSelector('textarea:not([disabled])', { timeout: 45000 })
        await session.logEvent('received_agent_reply', {})
    }
}
