// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * InferenceClient — the formal contract for Plexo's model-agnostic inference layer.
 *
 * This interface documents the public API that exists across:
 *   - registry.ts (buildModel, resolveModel, testProvider)
 *   - router.ts (IntelligentRouter.route)
 *
 * Consumers should use resolveModel() for most cases — it handles routing,
 * fallback, and credential resolution internally. This interface exists for
 * documentation, testing, and future provider implementations.
 */

import type { ResolvedModelMeta } from './router.js'
import type {
    AnyLanguageModel,
    TaskType,
    ProviderKey,
    ProviderTestResult,
    WorkspaceAISettings,
} from './registry.js'

// ── Request / Response types ────────────────────────────────────

export interface InferenceRequest {
    /** The task type determines default model routing and capability requirements. */
    taskType: TaskType
    /** Workspace AI settings (provider config, keys, routing rules). */
    settings: WorkspaceAISettings
    /** Optional workspace ID for scoped credential decryption. */
    workspaceId?: string
}

export interface InferenceResult {
    /** Instantiated language model ready for generateText/generateObject/streamText. */
    model: AnyLanguageModel
    /** Metadata about the resolved model: provider, mode, cost estimates. */
    meta: ResolvedModelMeta
}

export interface ModelInfo {
    id: string
    provider: ProviderKey
    displayName?: string
    capabilities: string[]
    costPerMIn: number
    costPerMOut: number
    reliabilityScore: number
}

// ── Interface ───────────────────────────────────────────────────

export interface InferenceClient {
    /**
     * Resolve and instantiate a model for the given task type.
     * Handles routing mode selection, credential decryption, and fallback.
     *
     * @see resolveModel() in registry.ts — the canonical implementation.
     */
    resolve(request: InferenceRequest): Promise<InferenceResult>

    /**
     * Test connectivity to a specific provider.
     * Sends a minimal prompt and returns latency + detected model.
     *
     * @see testProvider() in registry.ts — the canonical implementation.
     */
    test(
        provider: ProviderKey,
        opts: { apiKey?: string; baseUrl?: string; model?: string },
        timeoutMs?: number,
    ): Promise<ProviderTestResult>

    /**
     * List known models for a provider, including capabilities and cost.
     * Sources from the models_knowledge table (synced from Portkey registry).
     *
     * @see syncModelKnowledge() in knowledge.ts — populates the backing store.
     */
    listModels(provider?: ProviderKey): Promise<ModelInfo[]>
}
