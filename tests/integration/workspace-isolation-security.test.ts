// SPDX-License-Identifier: AGPL-3.0-only
// Stabilization: SEC-P1 — Adversarial workspace isolation test suite.
// Verifies no API endpoint returns data from workspace B when authenticated as workspace A.

import { describe, it, expect } from 'vitest'

const API_URL = process.env.API_URL || 'http://localhost:3001'
const _WS_A = process.env.TEST_WORKSPACE_A || 'workspace-a-isolation-test'
const WS_B = process.env.TEST_WORKSPACE_B || 'workspace-b-isolation-test'
const API_KEY_A = process.env.TEST_API_KEY_A || ''
const API_KEY_B = process.env.TEST_API_KEY_B || ''

// Helper to make authenticated requests as workspace A
async function fetchAsA(path: string): Promise<Response> {
    return fetch(`${API_URL}${path}`, {
        headers: API_KEY_A ? { Authorization: `Bearer ${API_KEY_A}` } : {},
    })
}

describe.skipIf(!API_KEY_A || !API_KEY_B)('Workspace Isolation (SEC-P1)', () => {
    // These tests require two configured workspaces with API keys.
    // Skip in unit test mode — run as integration test with real DB.

    it('tasks endpoint returns only workspace A data', async () => {
        const res = await fetchAsA(`/api/v1/tasks?workspaceId=${WS_B}&limit=5`)
        // Should either 403 or return empty (not workspace B's tasks)
        if (res.status === 200) {
            const data = await res.json()
            const tasks = Array.isArray(data) ? data : data.tasks ?? []
            for (const task of tasks) {
                expect(task.workspaceId).not.toBe(WS_B)
            }
        } else {
            expect([401, 403]).toContain(res.status)
        }
    })

    it('memory endpoint rejects cross-workspace access', async () => {
        const res = await fetchAsA(`/api/v1/workspaces/${WS_B}/memory`)
        expect([401, 403, 404]).toContain(res.status)
    })

    it('introspection endpoint rejects cross-workspace access', async () => {
        const res = await fetchAsA(`/api/v1/workspaces/${WS_B}/introspect`)
        expect([401, 403, 404]).toContain(res.status)
    })

    it('provider instances endpoint rejects cross-workspace access', async () => {
        const res = await fetchAsA(`/api/v1/workspaces/${WS_B}/providers`)
        expect([401, 403, 404]).toContain(res.status)
    })

    it('RSI proposals endpoint rejects cross-workspace access', async () => {
        const res = await fetchAsA(`/api/v1/workspaces/${WS_B}/rsi/proposals`)
        expect([401, 403, 404]).toContain(res.status)
    })

    it('extensions endpoint rejects cross-workspace access', async () => {
        const res = await fetchAsA(`/api/v1/workspaces/${WS_B}/extensions`)
        expect([401, 403, 404]).toContain(res.status)
    })

    it('connections endpoint rejects cross-workspace access', async () => {
        const res = await fetchAsA(`/api/v1/workspaces/${WS_B}/connections`)
        expect([401, 403, 404]).toContain(res.status)
    })

    it('intelligence settings endpoint rejects cross-workspace access', async () => {
        const res = await fetchAsA(`/api/v1/intelligence/${WS_B}/settings`)
        expect([401, 403, 404]).toContain(res.status)
    })

    it('routing chains endpoint rejects cross-workspace access', async () => {
        const res = await fetchAsA(`/api/v1/workspaces/${WS_B}/routing-chains`)
        expect([401, 403, 404]).toContain(res.status)
    })
})
