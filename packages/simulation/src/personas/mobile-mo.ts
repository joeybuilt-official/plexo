// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Persona } from './index.js'
import { loginIfNeeded } from '../utils/login.js'

export const mobileMo: Persona = {
    id: 'mobile-mo',
    name: 'Mobile Mo',
    description: 'A mobile user navigating via tab bar.',
    viewport: { width: 375, height: 667 }, // iPhone SE
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1',
    run: async (page, session) => {
        await page.goto('/')
        await loginIfNeeded(page, session)
        await page.waitForSelector('nav.md\\:hidden')
        await session.logEvent('viewed_mobile_tab_bar', {})

        await page.click('nav.md\\:hidden a:has-text("Chat")')
        await page.waitForTimeout(500)
        await session.logEvent('mobile_navigated_to_chat', { url: page.url() })

        await page.waitForSelector('textarea')
        await session.logEvent('mobile_ui_check_passed', {})
    }
}
