// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P6 SCL Runtime E2E — proves MindsetObject compression, expansion,
 * and admin endpoints for the SCL pipeline.
 */
import { test, expect } from '@playwright/test'
import { hasAuthSession } from './_helpers'

const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
const HAS_SESSION = hasAuthSession()

test.describe('P6: SCL Runtime', () => {
    test.describe('MindsetObject Compression', () => {
        test('compress endpoint produces valid MindsetObject with synthetic data', async ({ request }) => {
            test.skip(!HAS_SESSION, 'No auth session — super-admin endpoints require valid session')
            const res = await request.post(`${API}/api/v1/scl-admin/compress`, {
                data: { domainRegion: 'code', useSynthetic: true },
            })
            expect(res.status()).toBe(200)
            const mindset = await res.json()
            expect(mindset).toHaveProperty('version', 'scl/0.2')
            expect(mindset).toHaveProperty('regions')
            expect(mindset).toHaveProperty('transformations')
            expect(mindset).toHaveProperty('attractors')
            expect(mindset.regions.length).toBeGreaterThan(0)
        })

        test('compressed MindsetObject has correct region structure', async ({ request }) => {
            test.skip(!HAS_SESSION, 'No auth session — super-admin endpoints require valid session')
            const res = await request.post(`${API}/api/v1/scl-admin/compress`, {
                data: { domainRegion: 'code', useSynthetic: true },
            })
            const mindset = await res.json()
            const region = mindset.regions[0]
            expect(region).toHaveProperty('id')
            expect(region).toHaveProperty('name')
            expect(region).toHaveProperty('taskCount')
            expect(region).toHaveProperty('topTools')
            expect(region).toHaveProperty('avgQuality')
        })
    })

    test.describe('MindsetObject Expansion', () => {
        test('expand produces context with token count', async ({ request }) => {
            test.skip(!HAS_SESSION, 'No auth session — super-admin endpoints require valid session')
            const res = await request.post(`${API}/api/v1/scl-admin/expand`, {
                data: { stimulus: 'Write a TypeScript function to parse JSON', taskType: 'coding' },
            })
            expect(res.status()).toBe(200)
            const expanded = await res.json()
            expect(expanded).toHaveProperty('relevantPatterns')
            expect(expanded).toHaveProperty('suggestedTools')
            expect(expanded).toHaveProperty('domainKnowledge')
            expect(expanded).toHaveProperty('tokenCount')
            expect(typeof expanded.tokenCount).toBe('number')
        })

        test('expand with empty stimulus returns 400', async ({ request }) => {
            test.skip(!HAS_SESSION, 'No auth session — super-admin endpoints require valid session')
            const res = await request.post(`${API}/api/v1/scl-admin/expand`, {
                data: { taskType: 'coding' },
            })
            expect(res.status()).toBe(400)
        })

        test('expanded context has fewer tokens than raw prose', async ({ request }) => {
            test.skip(!HAS_SESSION, 'No auth session — super-admin endpoints require valid session')
            const res = await request.post(`${API}/api/v1/scl-admin/expand`, {
                data: { stimulus: 'Deploy the application to production', taskType: 'ops' },
            })
            const expanded = await res.json()
            // Expanded context should be compact — much less than 2000 tokens
            expect(expanded.tokenCount).toBeLessThan(500)
        })
    })

    test.describe('Workspace Mindset', () => {
        test('mindset endpoint returns 404 for unknown workspace', async ({ request }) => {
            test.skip(!HAS_SESSION, 'No auth session — super-admin endpoints require valid session')
            const res = await request.get(`${API}/api/v1/scl-admin/mindset/00000000-0000-0000-0000-000000000000`)
            expect(res.status()).toBe(404)
        })
    })
})
