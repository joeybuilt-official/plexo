// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 stats — getAllStats() snapshot contract (Phase 4 observability).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
    recordCall,
    recordCooldown,
    getAllStats,
    _resetStatsForTest,
    type StatsKey,
} from '../stats.js'

const key: StatsKey = { workspaceId: 'ws-1', provider: 'openai', model: 'gpt-x', taskType: 'codeGeneration' }
const globalKey: StatsKey = { workspaceId: undefined, provider: 'ollama', model: 'llama-x', taskType: 'conversation' }

describe('getAllStats', () => {
    beforeEach(() => { _resetStatsForTest() })

    it('returns nothing when there are no buckets', () => {
        expect(getAllStats()).toEqual([])
    })

    it('snapshots a recorded bucket with its structured key', () => {
        recordCall(key, 100, true)
        recordCall(key, 300, false)
        const all = getAllStats()
        expect(all).toHaveLength(1)
        expect(all[0]!.key).toEqual(key)
        expect(all[0]!.stats.sampleCount).toBe(2)
        expect(all[0]!.stats.successRate).toBe(0.5)
    })

    it('preserves the undefined (global) workspace scope', () => {
        recordCall(globalKey, 50, true)
        const all = getAllStats()
        expect(all).toHaveLength(1)
        expect(all[0]!.key.workspaceId).toBeUndefined()
    })

    it('includes a sample-less bucket that is still in cooldown', () => {
        recordCooldown(key, Date.now() + 60_000)
        const all = getAllStats()
        expect(all).toHaveLength(1)
        expect(all[0]!.stats.cooldownEndAt).toBeGreaterThan(Date.now())
    })

    it('skips a sample-less bucket whose cooldown has elapsed', () => {
        recordCooldown(key, Date.now() - 1_000)
        expect(getAllStats()).toEqual([])
    })
})
