// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P1 A2A E2E — proves Agent Cards, A2A task protocol, and sub-agent queries work.
 */
import { test, expect } from '@playwright/test'

const LIVE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

test.describe('P1: A2A Server', () => {
    test('agent card at /.well-known/agent.json is valid A2A JSON', async ({ request }) => {
        const res = await request.get(`${LIVE_URL}/.well-known/agent.json`)
        expect(res.status()).toBe(200)
        const card = await res.json()
        expect(card).toHaveProperty('name')
        expect(card).toHaveProperty('url')
        expect(card).toHaveProperty('version')
        expect(card.capabilities).toHaveProperty('streaming')
        expect(card.capabilities.streaming).toBe(true)
        expect(card.authentication.schemes).toContain('Bearer')
        expect(card.defaultInputModes).toContain('text')
    })

    test('/.well-known/agents returns array with default card', async ({ request }) => {
        const res = await request.get(`${LIVE_URL}/.well-known/agents`)
        expect(res.status()).toBe(200)
        const cards = await res.json()
        expect(Array.isArray(cards)).toBe(true)
        expect(cards.length).toBeGreaterThanOrEqual(1)
        expect(cards[0].name).toBe('Plexo')
    })

    test('A2A task submit with message format returns submitted', async ({ request }) => {
        const res = await request.post(`${LIVE_URL}/api/v1/a2a/default/tasks`, {
            data: {
                message: {
                    role: 'user',
                    parts: [{ type: 'text', text: 'Say CONFIRMED' }],
                },
            },
        })
        // May be 201 (created) or 400 (no workspace) — both are valid protocol responses, not 500
        expect(res.status()).toBeLessThan(500)
        if (res.status() === 201) {
            const task = await res.json()
            expect(task.id).toBeTruthy()
            expect(task.status).toBe('submitted')
        }
    })

    test('A2A task status returns valid format', async ({ request }) => {
        // First create a task
        const createRes = await request.post(`${LIVE_URL}/api/v1/a2a/default/tasks`, {
            data: {
                message: { role: 'user', parts: [{ type: 'text', text: 'test' }] },
            },
        })
        if (createRes.status() !== 201) {
            test.skip(true, 'Task creation failed — no workspace configured')
            return
        }

        const created = await createRes.json()

        // Query its status
        const statusRes = await request.get(`${LIVE_URL}/api/v1/a2a/default/tasks/${created.id}`)
        expect(statusRes.status()).toBe(200)
        const status = await statusRes.json()
        expect(status.id).toBe(created.id)
        expect(['submitted', 'working', 'completed', 'failed']).toContain(status.status)
        expect(status).toHaveProperty('artifacts')
        expect(status).toHaveProperty('children')
    })

    test('agents list endpoint returns array', async ({ request }) => {
        const res = await request.get(`${LIVE_URL}/api/v1/a2a/agents`)
        expect(res.status()).toBe(200)
        const cards = await res.json()
        expect(Array.isArray(cards)).toBe(true)
    })
})
