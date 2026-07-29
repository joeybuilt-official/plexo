// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — provider quality warnings (ADR 0012 §C6 Q2).
 *
 * When the selector routes a task through a candidate whose `priorScore` is
 * below the "recommended" threshold (because the workspace has no higher-prior
 * provider installed), record the event and aggregate over the trailing 7-day
 * window. The workspace settings page reads these aggregates to render the
 * `provider_quality_warning` chip listing under-served tasks.
 *
 * No call-time noise per the no-bother-the-user rule.
 */

import type { TaskType } from '../registry.js'

/** Manifest entries strictly below this priorScore are "non-recommended". */
export const RECOMMENDED_PRIOR = 4 as const

const WINDOW_7D_MS = 7 * 24 * 60 * 60 * 1000

interface Sample {
    at: number
    priorScore: number
    provider: string
}

interface Bucket {
    samples: Sample[]
}

export interface QualityWarning {
    taskType: TaskType
    count: number
    lastAt: number
    lastProvider: string | undefined
    lastPriorScore: number | undefined
}

const store = new Map<string, Bucket>()

function keyOf(workspaceId: string | undefined, taskType: TaskType): string {
    return `${workspaceId ?? '*'}|${taskType}`
}

function trim(b: Bucket, now: number): void {
    const cutoff = now - WINDOW_7D_MS
    while (b.samples.length > 0 && b.samples[0]!.at < cutoff) b.samples.shift()
}

export function recordDegradation(input: {
    workspaceId: string | undefined
    taskType: TaskType
    provider: string
    priorScore: number
}): void {
    const { workspaceId, taskType, provider, priorScore } = input
    if (priorScore >= RECOMMENDED_PRIOR) return
    const k = keyOf(workspaceId, taskType)
    let b = store.get(k)
    if (!b) {
        b = { samples: [] }
        store.set(k, b)
    }
    const now = Date.now()
    b.samples.push({ at: now, priorScore, provider })
    trim(b, now)
}

export function getQualityWarning(
    workspaceId: string | undefined,
    taskType: TaskType,
): QualityWarning {
    const b = store.get(keyOf(workspaceId, taskType))
    if (!b) {
        return { taskType, count: 0, lastAt: 0, lastProvider: undefined, lastPriorScore: undefined }
    }
    trim(b, Date.now())
    if (b.samples.length === 0) {
        return { taskType, count: 0, lastAt: 0, lastProvider: undefined, lastPriorScore: undefined }
    }
    const last = b.samples[b.samples.length - 1]!
    return {
        taskType,
        count: b.samples.length,
        lastAt: last.at,
        lastProvider: last.provider,
        lastPriorScore: last.priorScore,
    }
}

export function getQualityWarningsAll(workspaceId: string | undefined): QualityWarning[] {
    const prefix = `${workspaceId ?? '*'}|`
    const out: QualityWarning[] = []
    const now = Date.now()
    for (const [k, b] of store.entries()) {
        if (!k.startsWith(prefix)) continue
        trim(b, now)
        if (b.samples.length === 0) continue
        const taskType = k.slice(prefix.length) as TaskType
        const last = b.samples[b.samples.length - 1]!
        out.push({
            taskType,
            count: b.samples.length,
            lastAt: last.at,
            lastProvider: last.provider,
            lastPriorScore: last.priorScore,
        })
    }
    return out.sort((a, b) => b.count - a.count)
}

/** Test-only — wipe all quality-warning state. */
export function _resetQualityWarningsForTest(): void {
    store.clear()
}
