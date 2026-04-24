// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { GoldenRecord } from './types.js'
import type { SCLConfig } from './config.js'

/**
 * Check all mechanics attractors for promotion to spirit.
 * An attractor qualifies when:
 * 1. It is currently mechanics (not spirit)
 * 2. mutationCount exceeds promotionMutationCount
 * 3. It is not already drift-protected
 *
 * Returns the number of attractors promoted.
 */
export function checkPromotions(record: GoldenRecord, config: SCLConfig): number {
    let promoted = 0

    for (const attractor of record.attractors) {
        if (attractor.depthClass !== 'mechanics') continue
        if (attractor.driftProtected) continue
        if (attractor.mutationCount <= config.promotionMutationCount) continue

        attractor.depthClass = 'spirit'
        attractor.driftProtected = true
        promoted++
    }

    return promoted
}
