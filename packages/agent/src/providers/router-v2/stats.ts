// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — in-memory rolling stats per (workspaceId, provider, model, taskType).
 *
 * Scope is explicitly workspace-scoped (pre-mortem #2 — never global).
 * No DB persistence in Phase 2; periodic snapshot to DB deferred to Phase 5.
 *
 * Window: last 500 calls OR last 7 days, whichever is smaller (ADR 0012 §C6 Q1).
 */

import type { ProviderKey, TaskType } from '../registry.js'

const MAX_SAMPLES = 500
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000  // 7 days (ADR 0012 §C6 Q1)

interface Sample {
    durationMs: number
    success: boolean
    at: number
}

interface Bucket {
    samples: Sample[]
    /** Epoch ms after which this provider is back in the pool (driven by recorded cooldowns). */
    cooldownEndAt: number
    /** Structured key, retained so getAllStats() can emit fields without parsing the composite string. */
    key: StatsKey
}

export interface StatsKey {
    workspaceId: string | undefined
    provider: ProviderKey
    model: string
    taskType: TaskType
}

export interface ReadStats {
    sampleCount: number
    successRate: number    // 0..1; defaults to 1.0 if no samples
    latencyP50Ms: number   // 0 if no samples
    latencyP95Ms: number   // 0 if no samples
    cooldownEndAt: number  // 0 if not in cooldown
    /**
     * Recent-failure penalty in [0, 1]. Computed from the tail of the window
     * to bias against very recent failures more than older ones.
     */
    recentFailurePenalty: number
}

function keyOf(k: StatsKey): string {
    return `${k.workspaceId ?? '*'}|${k.provider}|${k.model}|${k.taskType}`
}

const store = new Map<string, Bucket>()

function trim(b: Bucket, now: number): void {
    const cutoff = now - WINDOW_MS
    // Drop expired samples
    while (b.samples.length > 0 && b.samples[0]!.at < cutoff) b.samples.shift()
    // Cap on sample count
    while (b.samples.length > MAX_SAMPLES) b.samples.shift()
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    if (sorted.length === 1) return sorted[0]!
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    return sorted[idx]!
}

export function recordCall(key: StatsKey, durationMs: number, success: boolean): void {
    const k = keyOf(key)
    const now = Date.now()
    let b = store.get(k)
    if (!b) {
        b = { samples: [], cooldownEndAt: 0, key }
        store.set(k, b)
    }
    b.samples.push({ durationMs, success, at: now })
    trim(b, now)
}

/** Mark a (workspace, provider, model, task) tuple cooling-down until `untilEpochMs`. */
export function recordCooldown(key: StatsKey, untilEpochMs: number): void {
    const k = keyOf(key)
    let b = store.get(k)
    if (!b) {
        b = { samples: [], cooldownEndAt: 0, key }
        store.set(k, b)
    }
    b.cooldownEndAt = Math.max(b.cooldownEndAt, untilEpochMs)
}

export function getStats(key: StatsKey): ReadStats {
    const b = store.get(keyOf(key))
    const now = Date.now()
    if (!b) {
        return { sampleCount: 0, successRate: 1, latencyP50Ms: 0, latencyP95Ms: 0, cooldownEndAt: 0, recentFailurePenalty: 0 }
    }
    trim(b, now)
    const n = b.samples.length
    if (n === 0) {
        return { sampleCount: 0, successRate: 1, latencyP50Ms: 0, latencyP95Ms: 0, cooldownEndAt: b.cooldownEndAt, recentFailurePenalty: 0 }
    }
    const successes = b.samples.reduce((a, s) => a + (s.success ? 1 : 0), 0)
    const sortedDur = b.samples.map(s => s.durationMs).sort((x, y) => x - y)
    // Recent-failure penalty: count failures in last 25% of samples (min 1)
    const tailLen = Math.max(1, Math.floor(n * 0.25))
    const tail = b.samples.slice(-tailLen)
    const tailFails = tail.reduce((a, s) => a + (s.success ? 0 : 1), 0)
    const recentFailurePenalty = tailFails / tail.length
    return {
        sampleCount: n,
        successRate: successes / n,
        latencyP50Ms: percentile(sortedDur, 50),
        latencyP95Ms: percentile(sortedDur, 95),
        cooldownEndAt: b.cooldownEndAt > now ? b.cooldownEndAt : 0,
        recentFailurePenalty,
    }
}

/** Test-only — wipe all stats. */
export function _resetStatsForTest(): void {
    store.clear()
}

export interface AllStatsEntry {
    key: StatsKey
    stats: ReadStats
}

/**
 * Snapshot of every live bucket, for the periodic `router_v2_stats` persistence
 * cron (Phase 4 observability). Per-process — each API instance reports its own
 * in-memory view; cross-process aggregation happens at read time in the DB.
 * Empty buckets (no samples and not cooling) are skipped — nothing to persist.
 */
export function getAllStats(): AllStatsEntry[] {
    const now = Date.now()
    const out: AllStatsEntry[] = []
    for (const b of store.values()) {
        trim(b, now)
        if (b.samples.length === 0 && b.cooldownEndAt <= now) continue
        out.push({ key: b.key, stats: getStats(b.key) })
    }
    return out
}
