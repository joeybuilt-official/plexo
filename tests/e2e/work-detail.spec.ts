// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * F2 WORK DETAIL — verifies the enhanced /app/tasks/[id] page renders the
 * Plan, Lifecycle Timeline, and Verify sections after a task completes, and
 * that direct navigation to a non-existent task yields the project's 404.
 *
 * NOTE on determinism (mirrors plan-card.spec.ts): the planner is LLM-driven
 * and there is no stub mode in apps/api or packages/agent. Test 1 needs a
 * real planner round-trip plus task execution, so it's gated behind
 * E2E_RUN_LIVE_LLM=true to avoid surprise inference bills. Test 2 is fixme'd
 * for the same reason as Phase F1's mid-execution test — no stub means we
 * cannot reliably stage a mid-approval state. Test 3 is presence-only and
 * runs without any LLM.
 */
import { test, expect } from '@playwright/test'
import { hasAuthSession, dismissAnalyticsModal } from './_helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const HAS_SESSION = hasAuthSession()
const RUN_LIVE = process.env.E2E_RUN_LIVE_LLM === 'true'

const MULTI_STEP_PROMPT =
    'Push my code to the test branch and run the full test suite, then open a pull request.'

const TASK_ID_RE = /\/app\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

async function submitPrompt(page: import('@playwright/test').Page, text: string) {
    const input = page
        .locator('textarea, [data-testid="chat-input"], [contenteditable="true"]')
        .first()
    await input.waitFor({ state: 'visible', timeout: 15_000 })
    await input.click()
    await input.fill(text)
    await page.keyboard.press('Enter')
}

test.describe('F2 WORK DETAIL: enhanced detail page sections', () => {
    test('Detail page shows Plan, Timeline, and Verify sections', async ({ page }) => {
        test.skip(!HAS_SESSION, 'No auth session')
        test.skip(!RUN_LIVE, 'Set E2E_RUN_LIVE_LLM=true to run (no stub mode exists)')

        test.setTimeout(180_000)

        await page.goto(`${BASE}/app/chat`)
        await dismissAnalyticsModal(page)

        await submitPrompt(page, MULTI_STEP_PROMPT)

        // Wait for plan card, then approve to begin execution.
        const planCard = page.locator('[role="region"][aria-labelledby^="plan-card-"]').first()
        await planCard.waitFor({ state: 'visible', timeout: 30_000 })
        await planCard.getByRole('button', { name: /Proceed/i }).click()

        // The "Open work detail" link is added by @frontend; match by accessible name.
        // Allow a generous timeout — the task must reach task_complete first.
        const detailLink = page
            .getByRole('link', { name: /Open work detail|View work|Open detail/i })
            .first()
        await detailLink.waitFor({ state: 'visible', timeout: 120_000 })
        await detailLink.click()

        await expect(page).toHaveURL(TASK_ID_RE, { timeout: 10_000 })

        // Plan section — region with accessible name matching /Plan/.
        await expect(page.getByRole('region', { name: /Plan/i })).toBeVisible({ timeout: 10_000 })

        // Lifecycle Timeline — heading text owned by @copy; accept either label.
        await expect(page.getByRole('region', { name: /Timeline|Activity/i })).toBeVisible({
            timeout: 10_000,
        })

        // Verify section — region with accessible name matching /Verif/ (Verify or Verification).
        const verifyRegion = page.getByRole('region', { name: /Verif/i })
        await expect(verifyRegion).toBeVisible({ timeout: 10_000 })
        // Placeholder body when no verify data — exact wording owned by @copy module;
        // assert on the load-bearing prefix only.
        await expect(verifyRegion).toContainText(/no verification recorded/i)
    })

    test.fixme('Mid-approval task surfaces inline approval card on detail page', async ({
        page: _page,
    }) => {
        // FIXME: same blocker as Phase F1's mid-execution test — no PLEXO_LLM_STUB
        // means we cannot deterministically pause a task in the approval state on
        // a fresh session. Unfixme once stub mode lands; then drive the planner to
        // a known multi-step plan, navigate directly to /app/tasks/<id> while the
        // task is awaiting approval, and assert the inline approval card renders.
    })

    test('Direct navigation to a non-existent task returns 404', async ({ page }) => {
        test.skip(!HAS_SESSION, 'No auth session')

        // Zero UUID — guaranteed not to exist; the page calls notFound() which
        // renders apps/web/src/app/app/not-found.tsx ("Page not found").
        const resp = await page.goto(`${BASE}/app/tasks/00000000-0000-0000-0000-000000000000`)
        await dismissAnalyticsModal(page)

        // Next.js notFound() yields a 404 status on the document response.
        expect(resp?.status()).toBe(404)

        await expect(page.getByRole('heading', { name: /Page not found/i })).toBeVisible({
            timeout: 5_000,
        })
    })
})
