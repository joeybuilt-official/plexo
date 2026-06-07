// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@plexo/db', () => ({
    db: { execute },
    sql: Object.assign(function sqlTag() { return {} }, { raw: () => ({}), join: () => ({}) }),
}))
vi.mock('../pg-rows.js', () => ({ pgRows: (r: unknown) => (Array.isArray(r) ? r : undefined) }))

import { loadAppSpend } from '../intelligence-spend.js'

describe('loadAppSpend (Round-5 Phase 6 per-app attribution)', () => {
    beforeEach(() => execute.mockReset())

    it('maps grouped per-app rows and coerces pg numeric strings', async () => {
        execute.mockResolvedValueOnce([
            { app_id: 'fonto', requests: 120, input_tokens: '900000', output_tokens: '300000', priced_usd: 1.23 },
            { app_id: 'graphiti-sidecar', requests: 40, input_tokens: '200000', output_tokens: '50000', priced_usd: 0.4 },
            { app_id: 'agent', requests: 5, input_tokens: '10000', output_tokens: '2000', priced_usd: 0.01 },
        ])
        const rows = await loadAppSpend('00000000-0000-0000-0000-000000000001')
        expect(rows).toHaveLength(3)
        expect(rows[0]).toEqual({ appId: 'fonto', pricedUsd: 1.23, inputTokens: 900000, outputTokens: 300000, requests: 120 })
        expect(rows.find((r) => r.appId === 'agent')!.pricedUsd).toBeCloseTo(0.01, 6)
    })

    it('returns [] when no rows', async () => {
        execute.mockResolvedValueOnce([])
        expect(await loadAppSpend('ws')).toEqual([])
    })
})
