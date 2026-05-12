// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach } from 'vitest'
import {
    getCachedIntelligenceSettings,
    invalidateIntelligenceSettings,
    invalidateAllIntelligenceSettings,
    getIntelligenceCacheStats,
    type IntelligenceSettings,
} from '../intelligence-cache.js'

describe('intelligence-cache', () => {
    beforeEach(() => {
        invalidateAllIntelligenceSettings()
    })

    it('calls loader on cache miss and returns the value', async () => {
        let loaderCalls = 0
        const loader = async (): Promise<IntelligenceSettings> => {
            loaderCalls++
            return { inferenceMode: 'auto', costCeilingUsd: 50 }
        }
        const result = await getCachedIntelligenceSettings('ws-1', loader)
        expect(loaderCalls).toBe(1)
        expect(result.inferenceMode).toBe('auto')
        expect(result.costCeilingUsd).toBe(50)
    })

    it('returns the cached value on second call within the TTL', async () => {
        let loaderCalls = 0
        const loader = async (): Promise<IntelligenceSettings> => {
            loaderCalls++
            return { inferenceMode: 'byok' }
        }
        await getCachedIntelligenceSettings('ws-2', loader)
        await getCachedIntelligenceSettings('ws-2', loader)
        await getCachedIntelligenceSettings('ws-2', loader)
        expect(loaderCalls).toBe(1)
    })

    it('isolates cache entries between workspaces', async () => {
        const loaderA = async (): Promise<IntelligenceSettings> => ({ inferenceMode: 'auto' })
        const loaderB = async (): Promise<IntelligenceSettings> => ({ inferenceMode: 'byok' })
        const a = await getCachedIntelligenceSettings('ws-A', loaderA)
        const b = await getCachedIntelligenceSettings('ws-B', loaderB)
        expect(a.inferenceMode).toBe('auto')
        expect(b.inferenceMode).toBe('byok')
        expect(getIntelligenceCacheStats().size).toBe(2)
    })

    it('invalidates a single workspace and triggers a reload on next access', async () => {
        let loaderCalls = 0
        const loader = async (): Promise<IntelligenceSettings> => {
            loaderCalls++
            return { inferenceMode: 'auto' }
        }
        await getCachedIntelligenceSettings('ws-3', loader)
        invalidateIntelligenceSettings('ws-3')
        await getCachedIntelligenceSettings('ws-3', loader)
        expect(loaderCalls).toBe(2)
    })

    it('invalidates only the targeted workspace, leaving siblings cached', async () => {
        let aCalls = 0
        let bCalls = 0
        const loaderA = async (): Promise<IntelligenceSettings> => {
            aCalls++
            return { inferenceMode: 'auto' }
        }
        const loaderB = async (): Promise<IntelligenceSettings> => {
            bCalls++
            return { inferenceMode: 'byok' }
        }
        await getCachedIntelligenceSettings('ws-A', loaderA)
        await getCachedIntelligenceSettings('ws-B', loaderB)
        invalidateIntelligenceSettings('ws-A')
        await getCachedIntelligenceSettings('ws-A', loaderA)
        await getCachedIntelligenceSettings('ws-B', loaderB)
        expect(aCalls).toBe(2)
        expect(bCalls).toBe(1)
    })
})
