// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Edge adapter — Provider Router `ModelClient` for the session-fabric
 * `AgentSdkBackend` (Provider Router Backend #2).
 *
 * Clean Architecture: outer-ring driver. session-fabric declares the
 * `ModelClient` port; this file implements it structurally (not imported from
 * @plexo/session-fabric, so no new cross-package dep) and is wired at the
 * composition root (apps/api). Unlike `anthropic-model-client.ts`, this adapter
 * hardwires NO provider SDK: it delegates to Plexo's existing Provider Router
 * (`routeAndCall` → `callModel`), so provider/model selection and API-key/auth
 * degrade + cross-provider cascade come for free (feedback_no_hardwired_llm_provider).
 *
 * Effect deliberately NOT used: matches call-model.ts / planner/index.ts, which
 * are Promise + Result-free-of-Effect. Deps point inward only.
 *
 * SECURITY: pure text completion. No tools, no execution surface — same posture
 * as the Anthropic adapter; real step execution stays gated behind D2 (ADR 0050).
 */

import { routeAndCall } from '../providers/router-v2/index.js'
import type { TaskType, WorkspaceAISettings } from '../providers/registry.js'
import { PIN_SKIPPABLE_ERROR } from '../providers/pin-skippable.js'
import { anthropicModelClient } from './anthropic-model-client.js'

/** Structural mirror of session-fabric's `ModelClient` port. */
export interface ModelClient {
    complete(input: { system: string; user: string }): Promise<string>
}

export interface RouterModelClientOptions {
    /** When set, resolve real per-workspace settings via `loadSettings`; when absent, env-key defaults. */
    workspaceId?: string
    /** Directly injected settings — takes precedence over `loadSettings`. */
    settings?: WorkspaceAISettings
    /** Loader (e.g. loadSettingsFromInstances) — resolves the workspace's configured chain. */
    loadSettings?: (workspaceId: string) => Promise<WorkspaceAISettings | null>
    /** Registry tier THIS client's calls map to (the backend now builds a separate client for plan vs verify). Default 'planning'. */
    taskType?: TaskType
    /** Forwarded to callModel wall-clock timeout. Planner uses 120_000. */
    stepTimeoutMs?: number
}

/**
 * Same env-key default the planner uses (planner/index.ts:183) so a keyless/
 * single-provider dev box works with zero config via ANTHROPIC_API_KEY.
 */
function defaultSettings(): WorkspaceAISettings {
    return {
        primaryProvider: 'anthropic',
        fallbackChain: [],
        providers: { anthropic: { provider: 'anthropic' } },
    }
}

/**
 * Build a `ModelClient` backed by the Provider Router. `complete()` mirrors the
 * planner's delegation shape (planner/index.ts:244-268): resolve settings →
 * routeAndCall selects a provider and calls doCall → callModel returns text.
 * AgentSdkBackend keeps its own JSON-extract + Zod parse over the returned string.
 */
export function routerModelClient(opts: RouterModelClientOptions = {}): ModelClient {
    const taskType: TaskType = opts.taskType ?? 'planning'

    return {
        async complete({ system, user }) {
            try {
                let settings = opts.settings
                if (!settings && opts.workspaceId && opts.loadSettings) {
                    settings = (await opts.loadSettings(opts.workspaceId)) ?? undefined
                }
                settings ??= defaultSettings()

                // Workspace-pinned judge model — verify ('judging') clients only.
                // Mirrors quality-judge.ts pin precedence: try the pin FIRST when
                // its provider is connected (present in the enabled providers map);
                // on a pin-skippable error fall through to the router cascade.
                if (taskType === 'judging' && settings.judgeModel && settings.providers[settings.judgeModel.provider]) {
                    const { provider, model } = settings.judgeModel
                    const cfg = settings.providers[provider]
                    try {
                        const { buildModel } = await import('../providers/registry.js')
                        // Pin id passed as modelIdOverride (top precedence) so a
                        // workspace summarization modelOverride can't hijack the
                        // pinned judge — deliberate divergence from quality-judge.ts.
                        const pinned = buildModel(
                            provider,
                            { provider, apiKey: cfg?.apiKey, baseUrl: cfg?.baseUrl, model },
                            'summarization',
                            settings,
                            model,
                        )
                        const { callModel } = await import('../providers/call-model.js')
                        const r = await callModel({
                            model: pinned,
                            system,
                            prompt: user,
                            taskType,
                            provider,
                            stepTimeoutMs: opts.stepTimeoutMs,
                        })
                        if (r.text?.trim()) return r.text
                        // Empty pin completion → fall through to the cascade
                        // (mirrors doCall's empty-throw semantics below).
                        console.warn(
                            `[routerModelClient] pinned judge ${provider}/${model} skipped → cascade: empty completion`,
                        )
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err)
                        // Non-skippable → outer catch → anthropic floor (mirrors
                        // quality-judge's bail on non-skippable pin errors).
                        if (!PIN_SKIPPABLE_ERROR.test(msg)) throw err
                        console.warn(
                            `[routerModelClient] pinned judge ${provider}/${model} skipped → cascade: ${msg.slice(0, 200)}`,
                        )
                    }
                }

                return await routeAndCall({
                    workspaceId: opts.workspaceId,
                    taskType,
                    settings,
                    doCall: async (model) => {
                        const { callModel } = await import('../providers/call-model.js')
                        const r = await callModel({
                            model,
                            system,
                            prompt: user,
                            taskType,
                            stepTimeoutMs: opts.stepTimeoutMs,
                        })
                        // Empty/whitespace/refusal is not success — throw so routeAndCall
                        // classifies it and cascades to the next provider instead of
                        // returning ''. Total exhaustion is caught by the anthropic floor below.
                        if (!r.text?.trim()) throw new Error('empty completion')
                        return r.text
                    },
                })
            } catch {
                // Runtime hard floor: router cascade exhausted or settings load failed →
                // Anthropic (env ANTHROPIC_API_KEY). feedback_no_hardwired_llm_provider.
                return anthropicModelClient().complete({ system, user })
            }
        },
    }
}
