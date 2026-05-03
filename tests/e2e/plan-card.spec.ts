// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * F1 PLAN visibility — verifies the inline PlanCard renders for multi-step
 * tasks and (when deterministic LLM stubbing exists) that Proceed advances
 * execution.
 *
 * NOTE on determinism: at the time of writing, the planner is LLM-driven and
 * there is no PLEXO_LLM_STUB / MOCK_LLM env var in apps/api or packages/agent
 * (verified via `grep -rn "STUB\|MOCK_LLM" apps/api packages` — only hit was
 * an unrelated "stub" string in routes/registry.ts and self-knowledge tools).
 *
 * Consequence: tests that depend on a specific plan shape (≥3 steps, an OWD)
 * or on the absence of a plan card cannot be made reliable in CI without
 * paying real LLM costs and still risking flake. Those are marked `test.fixme`
 * and gated behind `PLEXO_LLM_STUB=true`. Test 1 (presence-only) runs against
 * a live LLM only when E2E_RUN_LIVE_LLM=true is set; otherwise it skips so
 * the operator never gets surprise inference bills.
 */
import { test, expect } from '@playwright/test'
import { hasAuthSession, dismissAnalyticsModal } from './_helpers'

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000'
const HAS_SESSION = hasAuthSession()
const HAS_STUB = process.env.PLEXO_LLM_STUB === 'true'
const RUN_LIVE = process.env.E2E_RUN_LIVE_LLM === 'true'

// Chosen prompt rationale: "Push my code to the test branch and run tests, then
// open a PR" — exercises (1) git push (one-way-door / write op), (2) test runner
// (long-running), (3) PR creation. A reasonable planner should emit ≥3 distinct
// steps and flag the push as requiring approval (OWD). If the planner produces
// fewer steps, the test will fail loudly, which is the right signal that either
// the prompt or the planner needs tuning.
const MULTI_STEP_PROMPT =
    'Push my code to the test branch and run the full test suite, then open a pull request.'

const TRIVIAL_PROMPT = 'What time is it?'

async function submitPrompt(page: import('@playwright/test').Page, text: string) {
    const input = page
        .locator('textarea, [data-testid="chat-input"], [contenteditable="true"]')
        .first()
    await input.waitFor({ state: 'visible', timeout: 15_000 })
    await input.click()
    await input.fill(text)
    await page.keyboard.press('Enter')
}

test.describe('F1 PLAN: inline PlanCard visibility', () => {
    test('PlanCard renders for multi-step task with OWD', async ({ page }) => {
        test.skip(!HAS_SESSION, 'No auth session')
        test.skip(!HAS_STUB && !RUN_LIVE, 'Set E2E_RUN_LIVE_LLM=true or PLEXO_LLM_STUB=true to run')

        await page.goto(`${BASE}/app/chat`)
        await dismissAnalyticsModal(page)

        await submitPrompt(page, MULTI_STEP_PROMPT)

        const planCard = page.locator('[role="region"][aria-labelledby^="plan-card-"]').first()
        await planCard.waitFor({ state: 'visible', timeout: 30_000 })

        await expect(planCard.getByRole('heading', { name: /^Plan$/ })).toBeVisible()

        const steps = planCard.locator('ol > li')
        await expect.poll(() => steps.count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(3)

        const proceed = planCard.getByRole('button', { name: /Proceed/i })
        const reject = planCard.getByRole('button', { name: /Reject/i })
        await expect(proceed).toBeVisible()
        await expect(reject).toBeVisible()
        await expect(proceed).toBeFocused()
    })

    test.fixme('Clicking Proceed advances execution', async ({ page }) => {
        // FIXME: requires deterministic planner output (PLEXO_LLM_STUB=true)
        // AND the @frontend PlanCard PR landed. The post-approval status text
        // ("Approved — running…") is owned by @frontend; lock the exact string
        // once their PR merges.
        test.skip(!HAS_SESSION, 'No auth session')
        test.skip(!HAS_STUB, 'Requires PLEXO_LLM_STUB=true for deterministic plan')

        await page.goto(`${BASE}/app/chat`)
        await dismissAnalyticsModal(page)
        await submitPrompt(page, MULTI_STEP_PROMPT)

        const planCard = page.locator('[role="region"][aria-labelledby^="plan-card-"]').first()
        await planCard.waitFor({ state: 'visible', timeout: 30_000 })

        await planCard.getByRole('button', { name: /Proceed/i }).click()

        await expect(planCard.getByText(/Approved.*running/i)).toBeVisible({ timeout: 10_000 })
        await expect(planCard.getByRole('button', { name: /Proceed/i })).toHaveCount(0)

        // Either the SSE-driven status text updates or a new agent message appears.
        await expect(
            page.locator('[data-testid="agent-message"], [role="article"]').last()
        ).toBeVisible({ timeout: 60_000 })
    })

    test.fixme('No PlanCard for trivial single-step prompt', async ({ page }) => {
        // FIXME: the planner could still emit a card for short prompts depending
        // on LLM whim. Reliable only with PLEXO_LLM_STUB=true.
        test.skip(!HAS_SESSION, 'No auth session')
        test.skip(!HAS_STUB, 'Requires PLEXO_LLM_STUB=true for deterministic plan')

        await page.goto(`${BASE}/app/chat`)
        await dismissAnalyticsModal(page)
        await submitPrompt(page, TRIVIAL_PROMPT)

        await page.waitForTimeout(10_000)
        const planCard = page.locator('[role="region"][aria-labelledby^="plan-card-"]')
        await expect(planCard).toHaveCount(0)
    })
})
