// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Provider lane isolation (ADR 0002).
 *
 * Background AI (memory summarization, quality judging, log analysis) must not
 * starve interactive task planning/execution/chat by holding all of a single
 * provider's concurrent slots. This module classifies each `taskType` into a
 * lane and gates the BACKGROUND lane behind a counting semaphore. The
 * INTERACTIVE lane is unbounded (ADR 0002 decision + pre-mortem #1): a
 * misclassification can only ever *unblock* interactive work, never block it.
 *
 * Disabled by default. Enable with `PLEXO_AI_LANE_ISOLATION=1`; OFF =
 * byte-identical to pre-ADR behaviour (zero-risk rollback via one env toggle).
 */

import type { TaskType } from '../registry.js'

export type Lane = 'interactive' | 'background'

const DEFAULT_BG_MAX_CONCURRENT = 2

// Fire-and-forget callers with no human or running task waiting on the result.
const BACKGROUND_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
    'summarization',
    'judging',
    'logAnalysis',
])

/** Pure classifier: which lane a task type belongs to. taskType-only (ADR 0002). */
export function laneFor(taskType: TaskType): Lane {
    return BACKGROUND_TASK_TYPES.has(taskType) ? 'background' : 'interactive'
}

export function laneIsolationEnabled(): boolean {
    return process.env.PLEXO_AI_LANE_ISOLATION === '1'
}

function backgroundMaxConcurrent(): number {
    const raw = process.env.PLEXO_BG_AI_MAX_CONCURRENT
    if (!raw) return DEFAULT_BG_MAX_CONCURRENT
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_BG_MAX_CONCURRENT
}

/**
 * Minimal async counting semaphore. `acquire` resolves when a slot is free;
 * `release` hands the freed slot directly to the next waiter (FIFO) so a slot is
 * never lost between a release and a pending acquire.
 */
export class Semaphore {
    private available: number
    private readonly queue: Array<() => void> = []

    constructor(max: number) {
        this.available = max
    }

    acquire(): Promise<void> {
        if (this.available > 0) {
            this.available--
            return Promise.resolve()
        }
        return new Promise<void>((resolve) => this.queue.push(resolve))
    }

    release(): void {
        const next = this.queue.shift()
        if (next) {
            // Hand the held slot straight to the next waiter; `available` stays
            // consumed because the waiter now owns the slot.
            next()
        } else {
            this.available++
        }
    }

    /** Test/introspection helpers. */
    get inFlightFree(): number { return this.available }
    get waiting(): number { return this.queue.length }
}

let bgSemaphore: Semaphore | null = null

function backgroundSemaphore(): Semaphore {
    if (!bgSemaphore) bgSemaphore = new Semaphore(backgroundMaxConcurrent())
    return bgSemaphore
}

/**
 * Lane observability counters (Phase L deferred metrics; Round-4 minimal gauge).
 * Surfaced via the router-stats snapshot cron. `queued`/`maxQueueDepth` prove the
 * background cap is actually engaging; `overrides` isolates lane-override-forced
 * traffic (e.g. graphiti via the inference proxy) from taskType-classified bg.
 */
interface LaneStats { bgAcquired: number; bgQueued: number; bgMaxQueueDepth: number; bgOverrides: number }
const laneStats: LaneStats = { bgAcquired: 0, bgQueued: 0, bgMaxQueueDepth: 0, bgOverrides: 0 }

/** Snapshot of the background-lane counters (copy). */
export function getLaneStats(): LaneStats {
    return { ...laneStats }
}

/**
 * Run `fn` under its lane.
 * - Flag OFF: passthrough (no semaphore, no extra Promise hop on the success
 *   path beyond the call itself) — identical to pre-ADR behaviour.
 * - INTERACTIVE lane: unbounded passthrough.
 * - BACKGROUND lane: acquire a permit, run, release in `finally` (release runs
 *   on throw too — pre-mortem #2 leak guard).
 *
 * `laneOverride` lets a trusted caller force the lane independent of taskType —
 * e.g. the inference proxy routes a background app's (graphiti) schema-mode
 * `extraction` call into the background lane without globally reclassifying
 * `extraction` (Round-4: preserves the Phase L taskType-only decision).
 */
export async function withLane<T>(taskType: TaskType, fn: () => Promise<T>, laneOverride?: Lane): Promise<T> {
    if (!laneIsolationEnabled()) return fn()
    if ((laneOverride ?? laneFor(taskType)) === 'interactive') return fn()

    const sem = backgroundSemaphore()
    laneStats.bgAcquired++
    if (laneOverride === 'background') laneStats.bgOverrides++
    if (sem.inFlightFree === 0) {
        laneStats.bgQueued++
        const depth = sem.waiting + 1
        if (depth > laneStats.bgMaxQueueDepth) laneStats.bgMaxQueueDepth = depth
    }
    await sem.acquire()
    try {
        return await fn()
    } finally {
        sem.release()
    }
}

/** Reset the module-level background semaphore + counters. Tests only. */
export function _resetLaneLimiterForTest(): void {
    bgSemaphore = null
    laneStats.bgAcquired = 0
    laneStats.bgQueued = 0
    laneStats.bgMaxQueueDepth = 0
    laneStats.bgOverrides = 0
}
