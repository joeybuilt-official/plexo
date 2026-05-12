// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — shadow-mode equivalence harness (Phase 3 item 4).
 *
 * When `ROUTER_V2_SHADOW=true` and `ROUTER_V2_ENABLED=false`, callers serve
 * the user response from the legacy `withFallback` path AND run
 * `routeAndCall` in parallel as a no-op observer. The shadow result is
 * never returned to the caller; its only product is a
 * `model.routed.shadow_compare` telemetry event.
 *
 * Invariants:
 *   1. Shadow MUST NOT block the user-facing request — it is fire-and-forget.
 *   2. Shadow errors MUST NOT surface to the user. All exceptions caught.
 *   3. Both paths see identical input — caller wires the same { settings,
 *      taskType, workspaceId, doCall } to both.
 *
 * Schema (one-way door — Phase 3 exit gate freezes it):
 *   {
 *     event: 'model.routed.shadow_compare'
 *     workspaceId, taskType,
 *     primary_provider, primary_model, primary_status, primary_latency_ms,
 *     shadow_provider, shadow_model, shadow_status, shadow_latency_ms,
 *     response_shape_match: boolean,
 *     primary_error_class, shadow_error_class
 *   }
 */

import type { TaskType } from '../registry.js'

export type ShadowStatus = 'ok' | 'error'

export interface ShadowPrimaryOutcome {
    provider: string
    model: string | undefined
    status: ShadowStatus
    latencyMs: number
    errorClass?: string
    /** Captured result shape — used to compare response_shape_match. */
    resultKeys?: readonly string[]
}

export interface ShadowSecondaryOutcome {
    provider: string
    model: string | undefined
    status: ShadowStatus
    latencyMs: number
    errorClass?: string
    resultKeys?: readonly string[]
}

export interface ShadowCompareEvent {
    event: 'model.routed.shadow_compare'
    workspaceId: string | undefined
    taskType: TaskType
    primary_provider: string
    primary_model: string | undefined
    primary_status: ShadowStatus
    primary_latency_ms: number
    primary_error_class: string | undefined
    shadow_provider: string | undefined
    shadow_model: string | undefined
    shadow_status: ShadowStatus
    shadow_latency_ms: number
    shadow_error_class: string | undefined
    response_shape_match: boolean
}

/**
 * Extract a stable, comparable view of a successful call result. Two results
 * "match shape" when they have the same top-level keys (e.g. both have
 * `text` + `inputTokens` + ... or both have `object` + ...) — token counts
 * and content are expected to differ across providers, so we don't compare
 * them.
 */
export function extractShapeKeys(value: unknown): readonly string[] {
    if (value === null || value === undefined || typeof value !== 'object') return []
    return Object.keys(value as Record<string, unknown>).sort()
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
}

/**
 * Compute `response_shape_match`:
 *   - both ok + same sorted top-level keys → true
 *   - both errored with the same errorClass → true (matched failure)
 *   - any other combination → false
 */
export function computeShapeMatch(
    primary: ShadowPrimaryOutcome,
    shadow: ShadowSecondaryOutcome,
): boolean {
    if (primary.status === 'ok' && shadow.status === 'ok') {
        return arraysEqual(primary.resultKeys ?? [], shadow.resultKeys ?? [])
    }
    if (primary.status === 'error' && shadow.status === 'error') {
        return (primary.errorClass ?? 'unknown') === (shadow.errorClass ?? 'unknown')
    }
    return false
}

export function buildShadowCompareEvent(args: {
    workspaceId: string | undefined
    taskType: TaskType
    primary: ShadowPrimaryOutcome
    shadow: ShadowSecondaryOutcome | null
}): ShadowCompareEvent {
    const { workspaceId, taskType, primary, shadow } = args
    if (!shadow) {
        return {
            event: 'model.routed.shadow_compare',
            workspaceId,
            taskType,
            primary_provider: primary.provider,
            primary_model: primary.model,
            primary_status: primary.status,
            primary_latency_ms: primary.latencyMs,
            primary_error_class: primary.errorClass,
            shadow_provider: undefined,
            shadow_model: undefined,
            shadow_status: 'error',
            shadow_latency_ms: 0,
            shadow_error_class: 'shadow-internal-failure',
            response_shape_match: false,
        }
    }
    return {
        event: 'model.routed.shadow_compare',
        workspaceId,
        taskType,
        primary_provider: primary.provider,
        primary_model: primary.model,
        primary_status: primary.status,
        primary_latency_ms: primary.latencyMs,
        primary_error_class: primary.errorClass,
        shadow_provider: shadow.provider,
        shadow_model: shadow.model,
        shadow_status: shadow.status,
        shadow_latency_ms: shadow.latencyMs,
        shadow_error_class: shadow.errorClass,
        response_shape_match: computeShapeMatch(primary, shadow),
    }
}

export type ShadowEmitter = (evt: ShadowCompareEvent) => void

/**
 * Default emitter — same console.info shape as `emitRoutedEvent`. Phase 5
 * wires the real sink. Test code injects its own via `runShadowCompare`'s
 * `emitter` arg.
 */
export const defaultShadowEmitter: ShadowEmitter = (evt) => {
    // eslint-disable-next-line no-console
    console.info(JSON.stringify(evt))
}

export interface RunShadowCompareInput<T> {
    workspaceId: string | undefined
    taskType: TaskType
    primary: ShadowPrimaryOutcome
    /** Runs the shadow path. Resolves with a value or throws. */
    runShadow: () => Promise<T>
    /** Extract { provider, model } from a successful shadow result. */
    extractRouted?: (result: T) => { provider: string | undefined; model: string | undefined }
    emitter?: ShadowEmitter
}

/**
 * Fire-and-forget shadow runner. Returns the Promise so tests can await it,
 * but callers in production SHOULD NOT await — invocations from request
 * handlers must drop the Promise after attaching a `.catch` that swallows
 * any unexpected exception (defense-in-depth; this function already swallows
 * internally).
 *
 * Errors thrown by `runShadow` are CAUGHT and recorded as the shadow
 * outcome's errorClass — never re-thrown.
 */
export async function runShadowCompare<T>(input: RunShadowCompareInput<T>): Promise<void> {
    const { workspaceId, taskType, primary, runShadow, extractRouted, emitter } = input
    const emit = emitter ?? defaultShadowEmitter

    let shadowOutcome: ShadowSecondaryOutcome | null = null
    const t0 = Date.now()
    try {
        const result = await runShadow()
        const latency = Date.now() - t0
        const routed = extractRouted ? extractRouted(result) : { provider: undefined, model: undefined }
        shadowOutcome = {
            provider: routed.provider ?? 'unknown',
            model: routed.model,
            status: 'ok',
            latencyMs: latency,
            resultKeys: extractShapeKeys(result),
        }
    } catch (err) {
        const latency = Date.now() - t0
        const cls = classifyShadowError(err)
        shadowOutcome = {
            provider: 'unknown',
            model: undefined,
            status: 'error',
            latencyMs: latency,
            errorClass: cls,
        }
    }

    try {
        emit(buildShadowCompareEvent({ workspaceId, taskType, primary, shadow: shadowOutcome }))
    } catch {
        // Defense-in-depth: telemetry emit MUST NOT throw out of shadow.
    }
}

function classifyShadowError(err: unknown): string {
    if (err === null || err === undefined) return 'unknown'
    if (err instanceof Error) {
        const name = err.name || 'Error'
        // Surface router-v2 specific codes when present (they carry `.code`).
        const code = (err as { code?: unknown }).code
        if (typeof code === 'string') return code
        return name
    }
    return typeof err
}

/** Process-boot env-var read. Reads ONCE per import — set before module load. */
export const ROUTER_V2_SHADOW: boolean =
    (process.env.ROUTER_V2_SHADOW ?? '').toLowerCase() === 'true' ||
    process.env.ROUTER_V2_SHADOW === '1'

let _testShadowOverride: boolean | null = null
export function _setRouterV2ShadowEnabledForTest(v: boolean | null): void { _testShadowOverride = v }
export function isRouterV2ShadowEnabled(): boolean {
    if (_testShadowOverride !== null) return _testShadowOverride
    return ROUTER_V2_SHADOW
}
