// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../channel-delivery.js', () => ({ getChannelToken: () => undefined }))

import { recordBudgetAlertForAlert, _opsAlertBufferSizes, flushOpsAlerts } from '../ops-alerts.js'

describe('ops-alerts budget stream (Round-5 Phase 6)', () => {
    beforeEach(async () => {
        // Drain any buffered state from a prior test (delivery unconfigured → clears).
        delete process.env.PLEXO_OPS_ALERT_WORKSPACE_ID
        delete process.env.PLEXO_OPS_ALERT_CHAT_ID
        await flushOpsAlerts()
    })

    it('buffers budget alerts and reports them in the buffer sizes', () => {
        recordBudgetAlertForAlert({ workspaceId: '69d1f1f1-aaaa', costUsd: 41.2, ceilingUsd: 50 })
        expect(_opsAlertBufferSizes().budget).toBe(1)
    })

    it('flush clears the budget buffer even when delivery is unconfigured', async () => {
        recordBudgetAlertForAlert({ workspaceId: '69d1f1f1-aaaa', costUsd: 41.2, ceilingUsd: 50 })
        expect(_opsAlertBufferSizes().budget).toBe(1)
        await flushOpsAlerts()
        expect(_opsAlertBufferSizes().budget).toBe(0)
    })

    it('does not deliver when only nothing is buffered (no throw)', async () => {
        await expect(flushOpsAlerts()).resolves.toBeUndefined()
        expect(_opsAlertBufferSizes()).toEqual({ provider: 0, canary: 0, budget: 0, slo: 0 })
    })
})
