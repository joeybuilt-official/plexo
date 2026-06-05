// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — public entry point.
 *
 * `routeAndCall<T>({ workspaceId, taskType, settings, doCall, opts? })`
 * is the only path callers use to invoke a provider model with cascade.
 *
 * Internal flow:
 *   1. Build candidate list from settings.providers.
 *   2. selectModel(...) — pure scorer → SelectionResult.
 *   3. If requireOperatorAction → throw a typed error (caller decides UX).
 *   4. Call chosen; on retryable error → classify → recordCooldown +
 *      recordCall, then re-select with that candidate excluded, retry once.
 *   5. If still failing → throw with `router-v2 cascade exhausted`.
 */

import {
    buildModel,
    type AnyLanguageModel,
    type AIProviderConfig,
    type FallbackOptions,
    type ProviderKey,
    type TaskType,
    type WorkspaceAISettings,
} from '../registry.js'
import { selectModel, resolveModelId, type AvailableProvider, type SelectionResult } from './selector.js'
import { recordCall, recordCooldown } from './stats.js'
import { classifyError } from './error-classifier.js'
import { recordAuthFailure, recordAuthSuccess } from './auth-events.js'
import { recordDegradation } from './quality-warnings.js'
import { buildRoutedEvent, emitRoutedEvent } from './telemetry.js'
import { emitProviderFailure } from './ops-events.js'
import { withLane } from './lane-limiter.js'

export * from './manifest.js'
export * from './lane-limiter.js'
export * from './selector.js'
export * from './error-classifier.js'
export * from './stats.js'
export * from './telemetry.js'
export * from './auth-events.js'
export * from './ops-events.js'
export * from './quality-warnings.js'

const COOLDOWN_RATE_LIMIT_MS = 60_000
const COOLDOWN_TRANSIENT_MS = 15_000
const COOLDOWN_AUTH_MS = 10 * 60_000
const COOLDOWN_QUOTA_MS = 30 * 60_000

const MAX_CASCADE = 4

// Retry-same: for transient errors (e.g. an empty stream) a re-call of the
// SAME model usually succeeds. We retry in place — bounded, with short backoff
// — BEFORE advancing to another provider. This is what lets a workspace with a
// single configured model survive a transient blip instead of hard-failing.
const RETRY_SAME_MAX = 2
const RETRY_SAME_BACKOFF_MS = 400

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class RouterV2NoCandidateError extends Error {
    readonly code = 'ROUTER_V2_NO_CANDIDATE'
    readonly requireOperatorAction: boolean
    constructor(message: string, requireOperatorAction: boolean) {
        super(message)
        this.name = 'RouterV2NoCandidateError'
        this.requireOperatorAction = requireOperatorAction
    }
}

export class RouterV2CascadeExhausted extends Error {
    readonly code = 'ROUTER_V2_CASCADE_EXHAUSTED'
    constructor(message: string, public readonly lastError: unknown) {
        super(message)
        this.name = 'RouterV2CascadeExhausted'
    }
}

/**
 * Marker class wrapping a user-thrown error that the router classified as
 * non-fallback. Callers can unwrap `err.cause` to get the original error
 * (notably for AbortError/TimeoutError retry logic at the call site).
 */
export class RouterV2CallError extends Error {
    readonly code = 'ROUTER_V2_CALL_ERROR'
    constructor(public readonly cause: unknown) {
        const m = cause instanceof Error ? cause.message : String(cause)
        super(m)
        this.name = 'RouterV2CallError'
    }
}

function buildAvailable(settings: WorkspaceAISettings): AvailableProvider[] {
    const out: AvailableProvider[] = []
    // Honor preference order: primary then fallbackChain — informational only;
    // selector scores by manifest + stats, not by chain position.
    const seen = new Set<ProviderKey>()
    const addIfEnabled = (key: ProviderKey) => {
        if (seen.has(key)) return
        const cfg = settings.providers[key] as AIProviderConfig | undefined
        if (!cfg) return
        if (cfg.enabled === false) return
        seen.add(key)
        out.push({ provider: key, config: cfg })
    }
    addIfEnabled(settings.primaryProvider)
    for (const k of settings.fallbackChain) addIfEnabled(k)
    // Surface other configured providers too — they're scored but ranked by manifest.
    for (const k of Object.keys(settings.providers) as ProviderKey[]) addIfEnabled(k)
    return out
}

function cooldownMsForClass(c: ReturnType<typeof classifyError>): number {
    switch (c.class) {
        case 'rate-limit': return c.retryAfterMs ?? COOLDOWN_RATE_LIMIT_MS
        case 'transient-5xx': return COOLDOWN_TRANSIENT_MS
        case 'network': return COOLDOWN_TRANSIENT_MS
        case 'auth': return COOLDOWN_AUTH_MS
        case 'quota': return COOLDOWN_QUOTA_MS
        case 'context-window': return COOLDOWN_TRANSIENT_MS
        case 'content-policy': return COOLDOWN_TRANSIENT_MS
        case 'parse-malformed': return COOLDOWN_TRANSIENT_MS
        default: return COOLDOWN_TRANSIENT_MS
    }
}

export interface RouteAndCallInput<T> {
    workspaceId: string | undefined
    taskType: TaskType
    settings: WorkspaceAISettings
    doCall: (model: AnyLanguageModel) => Promise<T>
    opts?: FallbackOptions
}

/**
 * Router v2 equivalent of `withFallback`. Selects → calls → records.
 * On retryable error: cools down chosen, re-selects with chosen excluded, retries.
 * Up to MAX_CASCADE attempts.
 */
export async function routeAndCall<T>(input: RouteAndCallInput<T>): Promise<T> {
    // ADR 0002: gate background-lane calls behind a concurrency cap so memory/
    // judge/summarization churn cannot starve interactive task planning. Flag
    // OFF (default) → passthrough, byte-identical to pre-ADR behaviour.
    return withLane(input.taskType, () => routeAndCallInner(input))
}

async function routeAndCallInner<T>(input: RouteAndCallInput<T>): Promise<T> {
    const { workspaceId, taskType, settings, doCall, opts } = input

    let available = buildAvailable(settings)
    if (available.length === 0) {
        throw new RouterV2NoCandidateError(
            `router-v2: no providers configured for workspace${workspaceId ? ' ' + workspaceId : ''}`,
            false,
        )
    }

    let lastError: unknown
    let fallbackEngaged = false
    let cascadePos = 0
    let sameRetries = 0
    let firstSelection: SelectionResult | null = null
    let firstSelectorDurationMs = 0
    let firstChosenProvider: string | undefined
    const skippedProviders: string[] = []

    while (cascadePos < MAX_CASCADE && available.length > 0) {
        const selStart = Date.now()
        const sel = selectModel({ workspaceId, taskType, availableProviders: available, settings })
        const selDur = Date.now() - selStart
        if (cascadePos === 0) {
            firstSelection = sel
            firstSelectorDurationMs = selDur
        }

        if (!sel.chosen) {
            // Emit telemetry even for failed routing so dashboards see the gap.
            emitRoutedEvent(buildRoutedEvent({
                workspaceId, taskType, selection: sel,
                selectorDurationMs: selDur, fallbackEngaged,
            }))
            if (sel.requireOperatorAction) {
                throw new RouterV2NoCandidateError(sel.rationale, true)
            }
            // noManifestMatch: the task type has no manifest entry on any configured
            // provider, but providers ARE configured. Rather than hard-fail (which
            // surfaces to the user as "Try again. / couldn't generate a response"),
            // fall back to the primary available provider's resolved model. "never
            // worse": only the previously-throwing path changes; normal selection is
            // untouched, and the high-stakes operator-action block above is preserved.
            const fb = available[0]
            if (fb) {
                const fbModel = resolveModelId(fb.provider, fb.config, taskType, settings)
                const fbStart = Date.now()
                try {
                    const model = buildModel(fb.provider, fb.config, taskType, settings)
                    const result = await doCall(model)
                    recordCall({ workspaceId, provider: fb.provider, model: fbModel, taskType }, Date.now() - fbStart, true)
                    recordAuthSuccess({ workspaceId, providerId: fb.provider })
                    return result
                } catch (err) {
                    recordCall({ workspaceId, provider: fb.provider, model: fbModel, taskType }, Date.now() - fbStart, false)
                    lastError = err
                }
            }
            throw new RouterV2NoCandidateError(sel.rationale, false)
        }

        const chosen = sel.chosen
        if (!firstChosenProvider) firstChosenProvider = chosen.provider
        const cfg = settings.providers[chosen.provider] as AIProviderConfig
        const t0 = Date.now()
        try {
            const model = buildModel(chosen.provider, cfg, taskType, settings)
            const result = await doCall(model)
            recordCall(
                { workspaceId, provider: chosen.provider, model: chosen.model, taskType },
                Date.now() - t0,
                true,
            )
            recordAuthSuccess({ workspaceId, providerId: chosen.provider })
            if (sel.degradationReason === 'workspace_low_quality_only') {
                recordDegradation({
                    workspaceId,
                    taskType,
                    provider: chosen.provider,
                    priorScore: chosen.priorScore,
                })
            }
            emitRoutedEvent(buildRoutedEvent({
                workspaceId, taskType, selection: sel,
                selectorDurationMs: selDur, fallbackEngaged,
            }))
            if (fallbackEngaged && firstChosenProvider) {
                const fbInfo = {
                    workspaceId,
                    taskType,
                    primary: firstChosenProvider,
                    used: chosen.provider,
                    skipped: [...skippedProviders],
                    lastError: lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError ?? ''),
                }
                try { opts?.onFallbackEngaged?.(fbInfo) } catch { /* best-effort */ }
            }
            return result
        } catch (err) {
            lastError = err
            const dur = Date.now() - t0
            recordCall(
                { workspaceId, provider: chosen.provider, model: chosen.model, taskType },
                dur,
                false,
            )

            const cls = classifyError(err)
            if (cls.class === 'auth' && err instanceof Error) {
                recordAuthFailure({
                    workspaceId,
                    providerId: chosen.provider,
                    modelId: chosen.model,
                    errorMessage: err.message,
                })
                try { opts?.onAuthFailure?.(chosen.provider, err.message) } catch { /* best effort */ }
            }
            if (!cls.shouldFallback) {
                emitRoutedEvent(buildRoutedEvent({
                    workspaceId, taskType, selection: sel,
                    selectorDurationMs: selDur, fallbackEngaged,
                }))
                throw new RouterV2CallError(err)
            }

            // Retry-same: transient failures (e.g. an empty stream) usually
            // succeed on a re-call of the SAME model. Retry in place — bounded,
            // with short backoff — WITHOUT cooling down or excluding the
            // provider. This keeps a single-provider workspace resilient: with
            // nothing to fall back to, the only path to recovery is retrying.
            if (cls.suggestedAction === 'retry-same' && sameRetries < RETRY_SAME_MAX) {
                sameRetries++
                await sleep(RETRY_SAME_BACKOFF_MS * sameRetries)
                continue
            }
            // Done retrying this provider — reset the budget for the next one.
            sameRetries = 0

            // Cool down the failed candidate so subsequent re-selection skips it.
            recordCooldown(
                { workspaceId, provider: chosen.provider, model: chosen.model, taskType },
                Date.now() + cooldownMsForClass(cls),
            )

            // Exclude the failed provider from the next iteration's candidate pool.
            skippedProviders.push(chosen.provider)
            available = available.filter(a => a.provider !== chosen.provider)
            fallbackEngaged = true
            cascadePos++
        }
    }

    // Cascade exhausted — emit telemetry with the first selection (or nothing if none).
    if (firstSelection) {
        emitRoutedEvent(buildRoutedEvent({
            workspaceId, taskType, selection: firstSelection,
            selectorDurationMs: firstSelectorDurationMs, fallbackEngaged: true,
        }))
    }
    // Provider-failure ops event: every candidate failed for this call.
    emitProviderFailure({
        kind: 'cascade_exhausted',
        workspaceId,
        provider: firstChosenProvider ?? 'unknown',
        taskType,
        skipped: skippedProviders,
        lastError: lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError ?? ''),
    })
    if (lastError instanceof Error) {
        throw new RouterV2CascadeExhausted(
            `router-v2 fallback chain exhausted: ${lastError.message.slice(0, 200)}`,
            lastError,
        )
    }
    throw new RouterV2CascadeExhausted('router-v2 fallback chain exhausted', lastError)
}

export interface RouteAndBuildResult {
    model: AnyLanguageModel
    meta: {
        id: string
        provider: ProviderKey
        mode: 'byok'
        costPerMIn: number
        costPerMOut: number
    }
}

/**
 * Pre-resolve a model without calling it. Returns the model instance + meta
 * for callers that need the model identity (vision gate, cost attribution,
 * identity line) before the actual generation step.
 *
 * Throws RouterV2NoCandidateError when no provider can be selected.
 */
export async function routeAndBuild(input: {
    workspaceId: string | undefined
    taskType: TaskType
    settings: WorkspaceAISettings
}): Promise<RouteAndBuildResult> {
    const { workspaceId, taskType, settings } = input
    const available = buildAvailable(settings)
    if (available.length === 0) {
        throw new RouterV2NoCandidateError(
            `router-v2: no providers configured for workspace${workspaceId ? ' ' + workspaceId : ''}`,
            false,
        )
    }
    const sel = selectModel({ workspaceId, taskType, availableProviders: available, settings })
    if (!sel.chosen) {
        throw new RouterV2NoCandidateError(sel.rationale, sel.requireOperatorAction)
    }
    const chosen = sel.chosen
    const cfg = settings.providers[chosen.provider] as AIProviderConfig
    const model = buildModel(chosen.provider, cfg, taskType, settings)
    return {
        model,
        meta: {
            id: chosen.model,
            provider: chosen.provider,
            mode: 'byok',
            costPerMIn: 3,
            costPerMOut: 15,
        },
    }
}

