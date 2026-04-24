// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for scl-core SCLConfig resolution.
 *
 * Pure — no DB, no network, no side effects.
 */

import { describe, it, expect } from 'vitest'
import { resolveConfig, DEFAULT_CONFIG, type SCLConfig } from '../src/config.js'

describe('resolveConfig', () => {
    it('returns DEFAULT_CONFIG when called with no argument', () => {
        expect(resolveConfig()).toEqual(DEFAULT_CONFIG)
    })

    it('returns DEFAULT_CONFIG when called with undefined', () => {
        expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    })

    it('overrides a single field, leaves the rest at defaults', () => {
        const result = resolveConfig({ spiritDriftThreshold: 0.5 })
        expect(result.spiritDriftThreshold).toBe(0.5)
        expect(result.refinementThreshold).toBe(DEFAULT_CONFIG.refinementThreshold)
        expect(result.ghostDisplacementThreshold).toBe(DEFAULT_CONFIG.ghostDisplacementThreshold)
        expect(result.promotionMutationCount).toBe(DEFAULT_CONFIG.promotionMutationCount)
        expect(result.promotionMaxDrift).toBe(DEFAULT_CONFIG.promotionMaxDrift)
        expect(result.refinementWeightIncoming).toBe(DEFAULT_CONFIG.refinementWeightIncoming)
    })

    it('overrides multiple fields simultaneously', () => {
        const overrides: Partial<SCLConfig> = {
            spiritDriftThreshold: 0.2,
            promotionMutationCount: 100,
            refinementWeightIncoming: 0.5,
        }
        const result = resolveConfig(overrides)
        expect(result.spiritDriftThreshold).toBe(0.2)
        expect(result.promotionMutationCount).toBe(100)
        expect(result.refinementWeightIncoming).toBe(0.5)
        // Unset fields stay at defaults
        expect(result.refinementThreshold).toBe(DEFAULT_CONFIG.refinementThreshold)
        expect(result.ghostDisplacementThreshold).toBe(DEFAULT_CONFIG.ghostDisplacementThreshold)
    })

    it('does not mutate DEFAULT_CONFIG', () => {
        const before = { ...DEFAULT_CONFIG }
        resolveConfig({ spiritDriftThreshold: 0.99 })
        expect(DEFAULT_CONFIG).toEqual(before)
    })

    it('returns DEFAULT_CONFIG reference when called with no args (no copy needed)', () => {
        // resolveConfig() fast-paths to the singleton when there are no overrides
        expect(resolveConfig()).toBe(DEFAULT_CONFIG)
    })

    it('returns a new object when called with partial overrides', () => {
        const result = resolveConfig({ spiritDriftThreshold: 0.2 })
        expect(result).not.toBe(DEFAULT_CONFIG)
    })

    it('overrides all fields when a complete config is provided', () => {
        const full: SCLConfig = {
            spiritDriftThreshold: 0.01,
            refinementThreshold: 0.01,
            ghostDisplacementThreshold: 0.01,
            promotionMutationCount: 1,
            promotionMaxDrift: 0.01,
            refinementWeightIncoming: 0.1,
        }
        expect(resolveConfig(full)).toEqual(full)
    })

    it('accepts zero values (falsy) without falling back to defaults', () => {
        const result = resolveConfig({ promotionMutationCount: 0, promotionMaxDrift: 0 })
        expect(result.promotionMutationCount).toBe(0)
        expect(result.promotionMaxDrift).toBe(0)
    })
})
