// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { GoldenRecord, DriftWarning } from './types.js'
import { weightedAverage } from './utils/vector.js'
import type { SCLConfig } from './config.js'

/**
 * Resolve a drift warning by either confirming or rejecting the held mutation.
 *
 * Confirm: apply the proposed position change using the standard refinement blend.
 * Reject: discard — no change to the attractor.
 */
export function resolveDrift(
    record: GoldenRecord,
    warning: DriftWarning,
    decision: 'confirm' | 'reject',
    config?: Partial<SCLConfig>,
): GoldenRecord {
    // Use the base incoming weight as the seed for the Robbins-Monro schedule,
    // same as mutate(). Without this, a spirit anchor with mutationCount=100
    // receives full 0.3 incoming weight on confirm instead of the ~0.03 it
    // would normally receive — a 10× over-mutation relative to normal refinement.
    const baseIncoming = config?.refinementWeightIncoming ?? 0.3

    const newRecord: GoldenRecord = {
        ...record,
        attractors: record.attractors.map(a => {
            if (a.id !== warning.attractorId) return a
            if (decision === 'reject') return a

            // Confirm: apply the held mutation with Robbins-Monro adaptive weight.
            const adaptiveIncoming = baseIncoming / Math.sqrt(a.mutationCount + 1)
            return {
                ...a,
                position: weightedAverage(a.position, warning.proposedPosition, 1 - adaptiveIncoming, adaptiveIncoming),
                mutationCount: a.mutationCount + 1,
                lastMutatedAt: Date.now(),
            }
        }),
        lastMutatedAt: Date.now(),
    }

    // Update warning status in-place (caller owns the warning object)
    warning.status = decision === 'confirm' ? 'confirmed' : 'rejected'

    return newRecord
}
