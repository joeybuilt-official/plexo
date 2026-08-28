// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * WCAG 2.1 AA structural checks (QA-opt FE8, ADR 0040) using Playwright
 * built-ins only — ADR 0033 forbids adding @axe-core. Runs at mobile-390 +
 * desktop-1440. Hard-asserts the high-confidence invariants (named controls,
 * image alts, a heading, disclosure aria-expanded, and WCAG 2.2 AA 24px button
 * target size); soft-reports the 24-44px AAA/44pt target-size band (UX7) via
 * test annotations so accepted AAA debt does not block the harness.
 */
import { test, expect } from '@playwright/test'
import { GATE_ROUTES } from './_helpers/routes'

for (const route of GATE_ROUTES) {
    test(`a11y: ${route.id}`, async ({ page }, testInfo) => {
        await page.goto(route.path)
        if (route.auth && /\/login|\/signin/.test(new URL(page.url()).pathname)) {
            test.skip(true, 'no authenticated session — set E2E_EMAIL/E2E_PASSWORD')
        }
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {})

        // 1. Heading present (document has a top-level heading).
        expect(await page.locator('h1, [role="heading"][aria-level="1"]').count(),
            'page must expose at least one top-level heading').toBeGreaterThan(0)

        // 2. Every visible <img> has a text alternative (alt) or is decorative
        //    (aria-hidden / empty alt with role=presentation).
        const imgViolations = await page.locator('img:visible').evaluateAll(imgs =>
            imgs.filter(el => {
                const img = el as HTMLImageElement
                if (img.getAttribute('aria-hidden') === 'true') return false
                if (img.getAttribute('role') === 'presentation') return false
                return img.getAttribute('alt') === null
            }).map(el => (el as HTMLImageElement).src.slice(0, 80)),
        )
        expect(imgViolations, `images missing alt: ${imgViolations.join(', ')}`).toEqual([])

        // 3. Every visible interactive control has an accessible name (text,
        //    aria-label/-labelledby, title, or a labelled icon child).
        const unnamed = await page.locator('button:visible, a[href]:visible, [role="button"]:visible').evaluateAll(els =>
            els.filter(el => {
                const txt = (el.textContent ?? '').trim()
                if (txt) return false
                if (el.getAttribute('aria-label')?.trim()) return false
                if (el.getAttribute('aria-labelledby')) return false
                if (el.getAttribute('title')?.trim()) return false
                const labelledChild = el.querySelector('[aria-label],[alt],[title]')
                if (labelledChild) return false
                return true
            }).map(el => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`),
        )
        expect(unnamed, `interactive controls with no accessible name: ${unnamed.join(', ')}`).toEqual([])

        // 4. Every visible form field has an accessible name (label/aria).
        const unlabeledInputs = await page.locator('input:visible, select:visible, textarea:visible').evaluateAll(els =>
            els.filter(el => {
                const input = el as HTMLInputElement
                if (input.type === 'hidden') return false
                if (input.getAttribute('aria-label')?.trim()) return false
                if (input.getAttribute('aria-labelledby')) return false
                if (input.getAttribute('title')?.trim()) return false
                if (input.getAttribute('placeholder')?.trim()) return false // weak, but counts as a name
                if (input.id && el.ownerDocument.querySelector(`label[for="${input.id}"]`)) return false
                if (input.closest('label')) return false
                return true
            }).map(el => `${el.tagName.toLowerCase()}[${(el as HTMLInputElement).type}]`),
        )
        expect(unlabeledInputs, `form fields with no label: ${unlabeledInputs.join(', ')}`).toEqual([])

        // 6. HARD (UX9): a disclosure / popup control (aria-haspopup or
        //    aria-controls) must expose its open/closed state via aria-expanded,
        //    else screen-reader users get no signal the chevron/menu toggled
        //    (WCAG 4.1.2). Scoped to the disclosure pattern so unrelated controls
        //    are never flagged.
        const noExpanded = await page.locator('button:visible, [role="button"]:visible').evaluateAll(els =>
            els.filter(el => {
                const disclosure = el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-controls')
                return disclosure && el.getAttribute('aria-expanded') === null
            }).map(el => `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`),
        )
        expect(noExpanded, `disclosure controls missing aria-expanded: ${noExpanded.join(', ')}`).toEqual([])

        // 5. HARD (UX7): icon/standalone button tap targets must meet WCAG 2.2
        //    AA Target Size (Minimum, 2.5.8 — 24x24 CSS px) on mobile. Scoped to
        //    <button>/[role=button] only: <a href> links are exempt as the spec's
        //    "inline" / navigation-in-text case (breadcrumbs, "View all", inline
        //    text links). Visually-hidden controls (.sr-only skip links) skipped.
        //    The 24-44px band (AAA 2.5.5 / 44pt HIG) stays a soft annotation.
        if (testInfo.project.name === 'mobile-390') {
            const measured = await page.locator('button:visible, [role="button"]:visible').evaluateAll(els =>
                els.filter(el => !el.closest('.sr-only') && !el.classList.contains('sr-only'))
                    .map(el => {
                        const r = el.getBoundingClientRect()
                        return { w: Math.round(r.width), h: Math.round(r.height), tag: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}` }
                    }).filter(b => b.w > 0 && b.h > 0),
            )
            const belowAA = measured.filter(b => b.w < 24 || b.h < 24)
            expect(belowAA, `buttons below WCAG 2.2 AA 24px target @390: ` + belowAA.map(s => `${s.tag} ${s.w}x${s.h}`).join('; ')).toEqual([])

            const aaaDebt = measured.filter(b => b.w < 44 || b.h < 44)
            if (aaaDebt.length) {
                testInfo.annotations.push({
                    type: 'wcag-target-size-aaa (soft)',
                    description: `${aaaDebt.length} target(s) 24-44px @390 (AAA/44pt debt): ` + aaaDebt.slice(0, 12).map(s => `${s.tag} ${s.w}x${s.h}`).join('; '),
                })
            }
        }
    })
}
