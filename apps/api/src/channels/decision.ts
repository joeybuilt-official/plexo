// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { DecisionIntent, DecisionResult } from './types.js'

/**
 * The shared decision handler — the single seam every channel's parse() lands
 * on. Routes by targetType to the existing, distinct handlers (verdict vs
 * revision). No channel-specific logic here.
 */
export interface DecisionHandlers {
    recordVerdict: (taskId: string, verdict: 'accept' | 'reject') => Promise<void>
    applyRevision: (revisionId: string, reviewedBy: string) => Promise<{ ok: boolean; error?: string }>
    rejectRevision: (revisionId: string, reviewedBy: string) => Promise<{ ok: boolean; error?: string }>
}

export async function applyDecision(intent: DecisionIntent, handlers: DecisionHandlers): Promise<DecisionResult> {
    const base = { targetType: intent.targetType, targetId: intent.targetId }

    if (intent.targetType === 'revision') {
        const r =
            intent.choice === 'approve'
                ? await handlers.applyRevision(intent.targetId, intent.actor)
                : await handlers.rejectRevision(intent.targetId, intent.actor)
        return { ...base, ok: r.ok, error: r.error }
    }

    if (intent.targetType === 'task') {
        // verdict vocabulary: approve -> accept (locked decision 1).
        await handlers.recordVerdict(intent.targetId, intent.choice === 'approve' ? 'accept' : 'reject')
        return { ...base, ok: true }
    }

    return { ...base, ok: false, error: 'unknown_target_type' }
}

/** Default handlers wired to the existing in-tree functions (lazy-imported). */
export const defaultDecisionHandlers: DecisionHandlers = {
    async recordVerdict(taskId, verdict) {
        const { recordHumanVerdict } = await import('../outcome-capture.js')
        await recordHumanVerdict(taskId, verdict)
    },
    async applyRevision(revisionId, reviewedBy) {
        const { applyRevision } = await import('../cron/distill-retro.js')
        return applyRevision(revisionId, reviewedBy)
    },
    async rejectRevision(revisionId, reviewedBy) {
        const { rejectRevision } = await import('../cron/distill-retro.js')
        return rejectRevision(revisionId, reviewedBy)
    },
}
