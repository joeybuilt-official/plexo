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
    /**
     * Warm-start baseline (AI7, gated by PLEXO_ROUTER_WARM_START). Read ONLY by
     * getStats when samples.length === 0, and discarded the instant the first
     * real sample lands. NEVER mixed into `samples` — percentiles + tail-penalty
     * stay computed from real samples only. sampleCount is deliberately surfaced
     * as 0 (the scorer ignores it; this keeps baseline-only buckets below the SLO
     * minSamples floor so warm-start can't fire spurious breach alerts).
     */
    baseline?: BaselineStats
}

/** Aggregate fallback used as a read-only warm-start before live samples accrue. */
export interface BaselineStats {
    successRate: number
    latencyP50Ms: number
    latencyP95Ms: number
    recentFailurePenalty: number
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

const clamp01 = (x: number): number => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0))

/** Warm-start kill-switch. Default OFF — getStats is byte-identical when unset. */
export function isWarmStartEnabled(): boolean {
    return process.env.PLEXO_ROUTER_WARM_START === '1'
}

/**
 * One snapshot row to hydrate (latest-per-key from router_v2_stats). Pure data —
 * packages/agent stays db-free; the API layer reads the table and passes rows in.
 * cooldownEndAt is epoch ms (0 = none).
 */
export interface HydrationEntry {
    key: StatsKey
    successRate: number
    latencyP50Ms: number
    latencyP95Ms: number
    recentFailurePenalty: number
    cooldownEndAt: number
}

/**
 * Warm-start hydration (AI7). Seeds a read-only `baseline` + cooldown onto buckets
 * that have no live samples yet, so the selector doesn't cold-start after a deploy.
 * Conservative + idempotent: never overwrites a bucket that already has real
 * samples, and only extends cooldowns (never shortens). Returns the count seeded.
 * Caller must gate on isWarmStartEnabled().
 */
export function hydrateFromSnapshots(entries: readonly HydrationEntry[]): number {
    const now = Date.now()
    let touched = 0
    for (const e of entries) {
        const k = keyOf(e.key)
        let b = store.get(k)
        if (!b) {
            b = { samples: [], cooldownEndAt: 0, key: e.key }
            store.set(k, b)
        }
        // Cooldown: only ever extend, never shorten; ignore stale/past values.
        if (e.cooldownEndAt > now && e.cooldownEndAt > b.cooldownEndAt) {
            b.cooldownEndAt = e.cooldownEndAt
        }
        // Baseline: only on still-cold buckets (no live samples yet).
        if (b.samples.length === 0) {
            b.baseline = {
                successRate: clamp01(e.successRate),
                latencyP50Ms: Math.max(0, e.latencyP50Ms),
                latencyP95Ms: Math.max(0, e.latencyP95Ms),
                recentFailurePenalty: clamp01(e.recentFailurePenalty),
            }
            touched++
        }
    }
    return touched
}

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
    // First real sample → drop any warm-start baseline (hard cutover; frees mem).
    if (b.baseline) b.baseline = undefined
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
        // Warm-start: fall back to the hydrated baseline if present. Reachable
        // ONLY with zero live samples; the first recordCall makes n>0 and the
        // baseline is never consulted again. sampleCount stays 0 so the scorer's
        // success/latency/penalty inputs are warm while the SLO minSamples gate
        // still skips this bucket (no spurious breach alerts).
        if (b.baseline) {
            return {
                sampleCount: 0,
                successRate: b.baseline.successRate,
                latencyP50Ms: b.baseline.latencyP50Ms,
                latencyP95Ms: b.baseline.latencyP95Ms,
                cooldownEndAt: b.cooldownEndAt > now ? b.cooldownEndAt : 0,
                recentFailurePenalty: b.baseline.recentFailurePenalty,
            }
        }
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
