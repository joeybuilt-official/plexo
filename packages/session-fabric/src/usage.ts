// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric usage rollup (Phase 2 slice 2d) — pure, framework-free, no IO.
 *
 * Read-only aggregation over the append-only event log's nullable usage columns.
 * Null usage values are treated as 0; `eventCount` counts only usage-bearing
 * events (those carrying any of model/tokensIn/tokensOut/costUsd).
 */

import type { SessionEvent } from './contract'

export interface UsageSummary {
    tokensIn: number
    tokensOut: number
    costUsd: number
    eventCount: number
    byModel: Array<{
        model: string
        provider: string | null
        tokensIn: number
        tokensOut: number
        costUsd: number
        eventCount: number
    }>
}

function hasUsage(e: SessionEvent): boolean {
    return e.model !== null || e.tokensIn !== null || e.tokensOut !== null || e.costUsd !== null
}

export function summarizeUsage(events: readonly SessionEvent[]): UsageSummary {
    let tokensIn = 0
    let tokensOut = 0
    let costUsd = 0
    let eventCount = 0
    const groups = new Map<string, UsageSummary['byModel'][number]>()

    for (const e of events) {
        if (!hasUsage(e)) continue
        eventCount += 1
        const ti = e.tokensIn ?? 0
        const to = e.tokensOut ?? 0
        const cu = e.costUsd ?? 0
        tokensIn += ti
        tokensOut += to
        costUsd += cu
        if (e.model === null) continue
        const g = groups.get(e.model)
        if (g) {
            g.tokensIn += ti
            g.tokensOut += to
            g.costUsd += cu
            g.eventCount += 1
        } else {
            groups.set(e.model, {
                model: e.model,
                provider: e.provider,
                tokensIn: ti,
                tokensOut: to,
                costUsd: cu,
                eventCount: 1,
            })
        }
    }

    const byModel = [...groups.values()].sort(
        (a, b) => b.costUsd - a.costUsd || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
    )

    return { tokensIn, tokensOut, costUsd, eventCount, byModel }
}
