// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — local-GPU fallback guard.
 *
 * Failure mode this closes (prod incident 2026-08): when a workspace's preferred
 * CLOUD providers (e.g. ollama_cloud / groq / cerebras) are all failing at ~100%,
 * the selector's scorer silently falls back to the LOCAL keyless `ollama`
 * provider (gemma3:4b) — which is healthy, so it wins and every `routeAndCall`
 * succeeds. Nothing bounds it: a broken cloud condition turns into an unbounded,
 * full-rate hammer on the local GPU (the incident ran ~20 req/min for 5+ hours,
 * pinning both GPUs and degrading every co-located service). Because each call
 * "succeeds", the existing `cascade_exhausted` ops alert never fires — it is
 * completely silent.
 *
 * The local `ollama` entry is documented in the manifest as the "local keyless
 * permanent CHAT fallback" — it is not meant to be a bulk background extraction
 * workhorse. This guard enforces that intent WITHOUT breaking legitimate
 * local-only / local-primary workspaces:
 *
 *   - It engages ONLY when the local provider is being used as a *degraded
 *     fallback* for a BULK/background task type — i.e. a preferred non-local
 *     (cloud) peer is configured but currently cooling / high-recent-failure.
 *     A workspace whose only (or intended primary) provider is local ollama has
 *     no failing cloud peer, so the guard never engages for it.
 *   - When engaged, it rate-limits local-fallback serves via a per-(workspace,
 *     taskType) token bucket. On deny the router cools the local candidate down
 *     (a pause the selector already honors) and lets the cascade surface a
 *     VISIBLE `cascade_exhausted` instead of silently pinning the GPU.
 *
 * Fully env-tunable; `PLEXO_LOCAL_FALLBACK_MAX_PER_MIN=0` disables it entirely
 * (byte-identical passthrough).
 */

import { getManifestEntry } from './manifest.js'
import { getStats } from './stats.js'
import { resolveModelId, type AvailableProvider } from './selector.js'
import type { ProviderKey, TaskType, WorkspaceAISettings } from '../registry.js'

/** Providers whose inference runs on the local host GPU (finite shared resource). */
const LOCAL_PROVIDER_KEYS: ReadonlySet<ProviderKey> = new Set<ProviderKey>(['ollama'])

export function isLocalProvider(provider: ProviderKey): boolean {
    return LOCAL_PROVIDER_KEYS.has(provider)
}

/**
 * Bulk / background task shapes that are fire-and-forget and high-volume — the
 * ones that can hammer local GPU without a human waiting. Interactive shapes
 * (conversation, planning, classification, ...) are deliberately excluded: a
 * user is blocked on them, so local fallback must stay unthrottled there.
 */
const BULK_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
    'extraction',
    'summarization',
    'judging',
    'logAnalysis',
])

export function isBulkTaskType(taskType: TaskType): boolean {
    return BULK_TASK_TYPES.has(taskType)
}

/**
 * A non-local peer counts as "failing" (making a local pick a degraded fallback)
 * when it is in cooldown OR its recent-failure penalty is at/above this bar.
 */
const CLOUD_FAILURE_PENALTY_THRESHOLD = 0.5

const WINDOW_MS = 60_000

/** Max local-fallback serves per (workspace, taskType) per minute. 0 = guard off. Default 6. */
export function localFallbackMaxPerMin(): number {
    const raw = process.env.PLEXO_LOCAL_FALLBACK_MAX_PER_MIN
    if (raw === undefined || raw.trim() === '') return 6
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 6
}

/** Cooldown applied to the local candidate on a throttle-deny (selector pause). Default 60s. */
export function localFallbackCooldownMs(): number {
    const raw = process.env.PLEXO_LOCAL_FALLBACK_COOLDOWN_MS
    if (raw === undefined || raw.trim() === '') return WINDOW_MS
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : WINDOW_MS
}

export function localFallbackGuardEnabled(): boolean {
    return localFallbackMaxPerMin() > 0
}

/**
 * True when at least one CONFIGURED non-local (cloud) peer for this task type is
 * currently failing (cooling or high recent-failure). When true, a local pick is
 * a degraded fallback rather than the workspace's intended primary — the only
 * condition under which we throttle. Pure read of the in-memory stats + manifest.
 */
export function hasFailingCloudPeer(input: {
    workspaceId: string | undefined
    taskType: TaskType
    available: AvailableProvider[]
    settings: WorkspaceAISettings
}): boolean {
    const { workspaceId, taskType, available, settings } = input
    const now = Date.now()
    for (const ap of available) {
        if (isLocalProvider(ap.provider)) continue
        if (!getManifestEntry(taskType, ap.provider)) continue
        const model = resolveModelId(ap.provider, ap.config, taskType, settings)
        const stats = getStats({ workspaceId, provider: ap.provider, model, taskType })
        if (stats.cooldownEndAt > now) return true
        if (stats.recentFailurePenalty >= CLOUD_FAILURE_PENALTY_THRESHOLD) return true
    }
    return false
}

interface Bucket { serves: number[] }
const buckets = new Map<string, Bucket>()

function keyOf(workspaceId: string | undefined, taskType: TaskType): string {
    return `${workspaceId ?? '*'}|${taskType}`
}

/**
 * Token-bucket check for a local-fallback serve. Returns true (and records the
 * serve) when under the per-minute cap; false when the cap is exhausted. A
 * `false` return means the caller must NOT call the local provider.
 */
export function tryConsumeLocalFallback(workspaceId: string | undefined, taskType: TaskType): boolean {
    const max = localFallbackMaxPerMin()
    if (max <= 0) return true
    const now = Date.now()
    const k = keyOf(workspaceId, taskType)
    let b = buckets.get(k)
    if (!b) { b = { serves: [] }; buckets.set(k, b) }
    while (b.serves.length > 0 && b.serves[0]! < now - WINDOW_MS) b.serves.shift()
    if (b.serves.length >= max) return false
    b.serves.push(now)
    return true
}

/** Test-only — wipe token buckets. */
export function _resetLocalGuardForTest(): void {
    buckets.clear()
}

export interface LocalFallbackThrottledEvent {
    event: 'router.local_fallback_throttled'
    workspaceId: string | undefined
    taskType: TaskType
    provider: ProviderKey
    model: string
    maxPerMin: number
    cooldownMs: number
}

// Optional metrics hook (mirrors setRoutedEventMetricsHook): lets apps/api turn
// throttle events into a Prometheus counter without packages/agent depending on
// the API metrics lib. Unset → no-op.
let _onThrottled: ((evt: LocalFallbackThrottledEvent) => void) | null = null
export function setLocalFallbackThrottledHook(fn: ((evt: LocalFallbackThrottledEvent) => void) | null): void {
    _onThrottled = fn
}

/**
 * Emit the throttle signal. Always writes a structured warn line so the
 * degraded-mode condition is VISIBLE in logs (the whole point — the pre-existing
 * behaviour was silent), plus fans out to the optional metrics hook.
 */
export function emitLocalFallbackThrottled(evt: LocalFallbackThrottledEvent): void {
    // eslint-disable-next-line no-console -- ops/log shape, same sink as telemetry.ts
    console.warn(JSON.stringify(evt))
    try { _onThrottled?.(evt) } catch { /* metrics must never break routing */ }
}
