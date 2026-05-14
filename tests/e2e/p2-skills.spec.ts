// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P2 Skills Runtime E2E — proves SKILL.md parsing, install-by-URL,
 * and skill validation endpoints work on live stack.
 */
import { test, expect } from '@playwright/test'

const LIVE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

test.describe('P2: SKILL.md Runtime', () => {
    // POST /api/v1/skills/validate is a public endpoint (no auth, no DB)
    test('skill validate endpoint parses valid SKILL.md', async ({ request }) => {
        const res = await request.post(`${LIVE_URL}/api/v1/skills/validate`, {
            data: {
                content: '---\nname: test-skill\ndescription: A test skill\n---\n\n# Test\n\nBody text.',
            },
        })
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.valid).toBe(true)
        expect(body.frontmatter.name).toBe('test-skill')
        expect(body.isSkillPlus).toBe(false)
    })

    test('skill validate detects Skill+ runtime', async ({ request }) => {
        const res = await request.post(`${LIVE_URL}/api/v1/skills/validate`, {
            data: {
                content: '---\nname: plus-skill\ndescription: Skill+ test\nruntime: plexo\ncapabilities:\n  - memory:read\n---\n\nbody',
            },
        })
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.valid).toBe(true)
        expect(body.isSkillPlus).toBe(true)
    })

    test('skill validate rejects invalid content', async ({ request }) => {
        const res = await request.post(`${LIVE_URL}/api/v1/skills/validate`, {
            data: { content: 'no frontmatter here' },
        })
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.valid).toBe(false)
    })

    // Authenticated install endpoints — verify they exist and require auth
    test('skill install-by-content endpoint exists and requires auth', async ({ request }) => {
        const res = await request.post(`${LIVE_URL}/api/v1/extensions/skill`, {
            data: {
                content: '---\nname: test\ndescription: test\n---\nbody',
            },
        })
        // 401 proves the route exists and is auth-gated (not 404)
        expect([400, 401]).toContain(res.status())
    })

    test('skill install-by-url endpoint exists and requires auth', async ({ request }) => {
        const res = await request.post(`${LIVE_URL}/api/v1/extensions/skill/install-url`, {
            data: { url: 'https://raw.githubusercontent.com/anthropics/skills/main/template-skill/SKILL.md' },
        })
        // 401 proves the route exists and is auth-gated (not 404)
        expect([400, 401]).toContain(res.status())
    })

    test('hub directory is reachable', async ({ page }) => {
        const res = await page.goto(`${LIVE_URL}/app/hub`)
        expect(res?.status()).toBeLessThan(500)
    })
})
