// SPDX-License-Identifier: MIT
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
import { classifyError, isBalanceExhaustedError } from './error-classifier.js'
import { markProviderBalanceExhausted } from '../settings-from-instances.js'
import { recordAuthFailure, recordAuthSuccess } from './auth-events.js'
import { recordDegradation } from './quality-warnings.js'
import { buildRoutedEvent, emitRoutedEvent } from './telemetry.js'
import { emitProviderFailure } from './ops-events.js'
import { withLane, type Lane } from './lane-limiter.js'
import {
    isLocalProvider,
    isBulkTaskType,
    localFallbackGuardEnabled,
    localFallbackCooldownMs,
    localFallbackMaxPerMin,
    hasFailingCloudPeer,
    tryConsumeLocalFallback,
    emitLocalFallbackThrottled,
} from './local-guard.js'

export * from './manifest.js'
export * from './lane-limiter.js'
export * from './selector.js'
export * from './error-classifier.js'
export * from './stats.js'
export * from './telemetry.js'
export * from './auth-events.js'
export * from './ops-events.js'
export * from './quality-warnings.js'
export * from './local-guard.js'

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

export class RouterV2TimeoutError extends Error {
    readonly code = 'ROUTER_V2_TIMEOUT'
    readonly class = 'transient-5xx'
    constructor(message: string = 'router-v2: call timed out after 30s') {
        super(message)
        this.name = 'RouterV2TimeoutError'
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
    // Order: primary then fallbackChain, then any other configured provider.
    // The selector scores by manifest + stats for the FIRST pick; on cascade
    // iterations it ranks by this chain order first (ADR 0012 Failure 3).
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

/**
 * True when a provider referenced by the workspace's preference order
 * (primaryProvider / fallbackChain) is ABSENT from settings.providers — the
 * signal that settings-from-instances pruned it (e.g. balanceExhaustedAt set,
 * see settings-from-instances.ts:180). Used to turn a dead-end NoCandidate into
 * an actionable operator error. Best-effort: a purely additive heuristic.
 */
function providersPrunedForExhaustion(settings: WorkspaceAISettings): boolean {
    const present = settings.providers as Record<string, unknown>
    if (settings.primaryProvider && !present[settings.primaryProvider]) return true
    for (const k of settings.fallbackChain) {
        if (!present[k]) return true
    }
    return false
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
        // A provider-specific 4xx rejection is not a client-wide fault; cool it
        // briefly and let the cascade try a different provider right away.
        case 'unknown-4xx': return COOLDOWN_TRANSIENT_MS
        // A capability mismatch (e.g. a model without tool support asked to do
        // tool calls) is a property of the model, not a transient fault. Cool
        // briefly so this cascade advances now; the cooldown is short because
        // the same model is perfectly eligible for non-tool calls.
        case 'capability-mismatch': return COOLDOWN_TRANSIENT_MS
        default: return COOLDOWN_TRANSIENT_MS
    }
}

export interface RouteAndCallInput<T> {
    workspaceId: string | undefined
    /**
     * Round-5 Phase 3: the task row this call serves, if any. Threaded only into
     * the routing_events telemetry sink so the decision can be joined to outcome.
     * Proxy-only callers (graphiti inference) leave it undefined.
     */
    taskId?: string
    taskType: TaskType
    settings: WorkspaceAISettings
    doCall: (model: AnyLanguageModel) => Promise<T>
    opts?: FallbackOptions
    /**
     * Force the concurrency lane independent of `taskType`. Used by trusted
     * callers (the inference proxy for background apps like graphiti) to put a
     * schema-mode `extraction` call into the background lane without globally
     * reclassifying the taskType. Affects lane gating only — manifest scoring
     * still uses `taskType`.
     */
    laneOverride?: Lane
    /**
     * Round-4 D2: per-call forced model (`provider/model` or bare `model`).
     * The selector force-picks it (bypassing scoring) when it maps to a
     * configured provider; on call failure the normal cascade takes over (the
     * forced provider is excluded, so re-selection scores the rest). Unset =
     * today's behaviour. Used by the inference proxy for background apps.
     */
    modelIdOverride?: string
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
    return withLane(input.taskType, () => routeAndCallInner(input), input.laneOverride)
}

async function routeAndCallInner<T>(input: RouteAndCallInput<T>): Promise<T> {
    const { workspaceId, taskId, taskType, settings, doCall, opts, modelIdOverride } = input

    const abortSignal = AbortSignal.timeout(30_000)

    let available = buildAvailable(settings)
    if (available.length === 0) {
        throw new RouterV2NoCandidateError(
            `router-v2: no providers configured for workspace${workspaceId ? ' ' + workspaceId : ''}`,
            false,
        )
    }

    let lastError: unknown
    // The most user-actionable error seen across the cascade (auth/quota outrank
    // a generic empty-output/network tail). Preserved so the exhausted error
    // surfaces "top up balance" / "fix your key" instead of the last provider's
    // opaque "No output generated".
    let actionableError: unknown
    let fallbackEngaged = false
    let cascadePos = 0
    let sameRetries = 0
    let firstSelection: SelectionResult | null = null
    let firstSelectorDurationMs = 0
    let firstChosenProvider: string | undefined
    const skippedProviders: string[] = []

    while (cascadePos < MAX_CASCADE && available.length > 0) {
        if (abortSignal.aborted) throw new RouterV2TimeoutError()
        const selStart = Date.now()
        // ADR 0012 Failure 3: the FIRST pick is "best per task" (Q1 hybrid
        // scoring). Every FALLBACK (cascadePos > 0) is dictated by the
        // workspace's configured chain — primary then fallbackChain — so the
        // operator's order is honored instead of the scorer silently reordering
        // it. Providers outside the chain still rank last (chainPos = MAX).
        const chainPreference = cascadePos === 0
            ? undefined
            : (settings.primaryProvider ? [settings.primaryProvider, ...settings.fallbackChain] : settings.fallbackChain)
        const sel = selectModel({ workspaceId, taskType, availableProviders: available, settings, modelIdOverride, chainPreference })
        const selDur = Date.now() - selStart
        if (cascadePos === 0) {
            firstSelection = sel
            firstSelectorDurationMs = selDur
        }

        if (!sel.chosen) {
            // Emit telemetry even for failed routing so dashboards see the gap.
            emitRoutedEvent(buildRoutedEvent({
                workspaceId, taskId, taskType, selection: sel,
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
                    if (abortSignal.aborted) throw new RouterV2TimeoutError()
                    const result = await doCall(model)
                    recordCall({ workspaceId, provider: fb.provider, model: fbModel, taskType }, Date.now() - fbStart, true)
                    recordAuthSuccess({ workspaceId, providerId: fb.provider })
                    return result
                } catch (err) {
                    recordCall({ workspaceId, provider: fb.provider, model: fbModel, taskType }, Date.now() - fbStart, false)
                    lastError = err
                }
            }
            // Resilience: if no candidate could serve this task AND paid providers
            // were pruned upstream for balance exhaustion (settings-from-instances
            // drops balanceExhaustedAt rows), the workspace has NO chat-capable
            // fallback left. Surface an ACTIONABLE operator error rather than the
            // silent NoCandidate — the local keyless `ollama` chat fallback should
            // normally prevent this, so reaching here means even it is unavailable.
            if (providersPrunedForExhaustion(settings)) {
                throw new RouterV2NoCandidateError(
                    'all paid providers out of credit and no chat-capable fallback is available; add credit to a provider or ensure the local ollama chat model (gemma3:4b) is reachable',
                    true,
                )
            }
            throw new RouterV2NoCandidateError(sel.rationale, false)
        }

        const chosen = sel.chosen
        if (!firstChosenProvider) firstChosenProvider = chosen.provider

        // Local-GPU fallback guard. A broken cloud-provider condition (all
        // preferred cloud peers failing) must not turn into an unbounded hammer
        // on the local ollama GPU. When the selector falls back to the LOCAL
        // provider for a BULK/background task *because* the cloud peers are
        // degraded, rate-limit it. On deny: cool the local candidate down (a
        // pause the selector honors), drop it from this cascade, and let the
        // loop surface a VISIBLE cascade_exhausted instead of silently pinning
        // local GPUs. Never engages when local is the intended primary/only
        // provider (no failing cloud peer) or for interactive task types.
        if (
            localFallbackGuardEnabled() &&
            isLocalProvider(chosen.provider) &&
            isBulkTaskType(taskType) &&
            hasFailingCloudPeer({ workspaceId, taskType, available, settings }) &&
            !tryConsumeLocalFallback(workspaceId, taskType)
        ) {
            const cooldownMs = localFallbackCooldownMs()
            recordCooldown(
                { workspaceId, provider: chosen.provider, model: chosen.model, taskType },
                Date.now() + cooldownMs,
            )
            emitLocalFallbackThrottled({
                event: 'router.local_fallback_throttled',
                workspaceId,
                taskType,
                provider: chosen.provider,
                model: chosen.model,
                maxPerMin: localFallbackMaxPerMin(),
                cooldownMs,
            })
            lastError = new Error(
                `local fallback throttled: ${chosen.provider}/${chosen.model} for ${taskType} — cloud providers degraded and local per-minute cap reached`,
            )
            // Throttle: cool the local candidate down (the selector honors the
            // cooldown) and drop it from this cascade so we surface a VISIBLE
            // cascade_exhausted instead of silently pinning local GPUs. A
            // per-model exclusion was previously keyed off a
            // `SelectionResult.candidates` field the selector no longer
            // exposes, so dropping the whole provider is the conservative
            // equivalent here.
            skippedProviders.push(chosen.provider)
            available = available.filter(a => a.provider !== chosen.provider)
            fallbackEngaged = true
            cascadePos++
            continue
        }

        const cfg = settings.providers[chosen.provider] as AIProviderConfig
        const t0 = Date.now()
        try {
            // D2 / Round-6: when the selector force-picked (D2) or model-routed
            // (Phase 2), pass the chosen model id so buildModel calls exactly that
            // model rather than the provider's default-resolved model.
            const model = buildModel(chosen.provider, cfg, taskType, settings, sel.forcedModel ? chosen.model : undefined)
            if (abortSignal.aborted) throw new RouterV2TimeoutError()
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
                workspaceId, taskId, taskType, selection: sel,
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
            // Track the most actionable error: auth/quota (billing/key problems)
            // outrank a generic empty-output or network tail. The exhausted error
            // surfaces this so the user sees "top up balance" / "fix your key"
            // rather than the last provider's opaque "No output generated".
            if (cls.class === 'auth' || cls.class === 'quota') {
                if (actionableError === undefined) actionableError = err
            }
            // Hard funds-depletion: persist the provider as balance-exhausted so
            // it's pulled from the routing chain (stops wasting a cascade slot on
            // a dead primary) and the web app surfaces a site-wide notice. Only
            // when a workspace is known (skip the env-fallback path). Fire-and-
            // forget — never block or fail the cascade. (Fix A)
            // Gated on the quota class: a rate-limit/network/5xx error must never
            // durably pull a provider even if its message carries billing-ish
            // words (belt-and-suspenders on top of the classifier's own guards).
            if (workspaceId && cls.class === 'quota' && isBalanceExhaustedError(err)) {
                void markProviderBalanceExhausted(workspaceId, chosen.provider)
            }
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
                    workspaceId, taskId, taskType, selection: sel,
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
                if (abortSignal.aborted) throw new RouterV2TimeoutError()
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

            // Exclude the failed candidate from the next iteration.
            skippedProviders.push(chosen.provider)
            available = available.filter(a => a.provider !== chosen.provider)
            fallbackEngaged = true
            cascadePos++
        }
    }

    // Cascade exhausted — emit telemetry with the first selection (or nothing if none).
    if (firstSelection) {
        emitRoutedEvent(buildRoutedEvent({
            workspaceId, taskId, taskType, selection: firstSelection,
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
            actionableError ?? lastError,
        )
    }
    throw new RouterV2CascadeExhausted('router-v2 fallback chain exhausted', actionableError ?? lastError)
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

