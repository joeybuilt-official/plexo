// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export interface SCLConfig {
    spiritDriftThreshold: number
    refinementThreshold: number
    ghostDisplacementThreshold: number
    promotionMutationCount: number
    promotionMaxDrift: number
    // Note: existingWeight is always (1 - refinementWeightIncoming) to guarantee
    // the convex combination sums to 1 under the Robbins-Monro schedule.
    refinementWeightIncoming: number
}

export const DEFAULT_CONFIG: SCLConfig = {
    spiritDriftThreshold: 0.15,
    refinementThreshold: 0.3,
    ghostDisplacementThreshold: 0.1,
    promotionMutationCount: 50,
    promotionMaxDrift: 0.05,
    refinementWeightIncoming: 0.3,
}

export function resolveConfig(partial?: Partial<SCLConfig>): SCLConfig {
    if (!partial) return DEFAULT_CONFIG
    return { ...DEFAULT_CONFIG, ...partial }
}
