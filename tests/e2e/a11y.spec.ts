// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * WCAG 2.1 AA structural checks (QA-opt FE8, ADR 0040) using Playwright
 * built-ins only — ADR 0033 forbids adding @axe-core. Runs at mobile-390 +
 * desktop-1440. Hard-asserts the high-confidence invariants (named controls,
 * image alts, a heading); soft-reports touch-target debt (UX7, known P2) via
 * test annotations so the harness is adoptable without blocking on accepted
 * pre-existing gaps.
 */
import { test, expect } from '@playwright/test'
import { ROUTES } from './_helpers/routes'

for (const route of ROUTES) {
    test(`a11y: ${route.id}`, async ({ page }, testInfo) => {
        await page.goto(route.path)
        if (route.auth && /\/login|\/signin/.test(new URL(page.url()).pathname)) {
            test.skip(true, 'no authenticated session — set E2E_EMAIL/E2E_PASSWORD')
        }
        await page.waitForLoadState('networkidle').catch(() => {})

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

        // 5. SOFT (UX7, known P2): touch targets < 44px on mobile. Reported as a
        //    test annotation, not a failure, so accepted pre-existing debt does
        //    not block the harness.
        if (testInfo.project.name === 'mobile-390') {
            const small = await page.locator('button:visible, a[href]:visible, [role="button"]:visible').evaluateAll(els =>
                els.filter(el => !el.closest('.sr-only') && !el.classList.contains('sr-only')) // skip visually-hidden (e.g. skip links)
                    .map(el => {
                        const r = el.getBoundingClientRect()
                        return { w: Math.round(r.width), h: Math.round(r.height), tag: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}` }
                    }).filter(b => b.w > 0 && b.h > 0 && (b.w < 44 || b.h < 44)),
            )
            if (small.length) {
                testInfo.annotations.push({
                    type: 'wcag-target-size (soft)',
                    description: `${small.length} target(s) < 44px @390: ` + small.slice(0, 12).map(s => `${s.tag} ${s.w}x${s.h}`).join('; '),
                })
            }
        }
    })
}
