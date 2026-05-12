// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Router v2 — quality manifest (rich shape per operator decision C1).
 *
 * Hand-curated table of (TaskType × ModelClass) → ManifestEntry.
 * Acts as the static prior when operational stats are sparse/absent.
 * PR-reviewed, versioned via `manifestVersion`.
 *
 * ADR 0012, plan.md Phase 2.
 */

import type { ProviderKey, TaskType } from '../registry.js'

export const manifestVersion = '1' as const

/**
 * Capability flags a model class exposes. Hand-curated; expand as needed.
 */
export type Capability =
    | 'json-mode'
    | 'tool-calling'
    | 'function-calling-strict'
    | 'vision'
    | 'long-context-200k'
    | 'long-context-1m'
    | 'low-latency'
    | 'streaming'

/**
 * Provider quirks the router/error-classifier must account for.
 * Surfaced in the manifest so they aren't buried in error-handling code (Rex).
 */
export type ProviderQuirk =
    | 'anthropic-429-respects-retry-after'
    | 'openai-no-retry-after'
    | 'google-content-policy-returns-200-with-refusal-string'
    | 'deepseek-slow-on-long-prompts'
    | 'openai-strict-json-mode'

export interface ManifestContext {
    workspaceId: string | undefined
    taskType: TaskType
    /** ID of the model that would run if this entry is chosen (post-resolution). */
    modelId: string | undefined
}

export interface ManifestEntry {
    /** 1–5; 5 = best-in-class on this taskType. From public leaderboard data. */
    qualityScore: 1 | 2 | 3 | 4 | 5
    capabilities: Capability[]
    quirks: ProviderQuirk[]
    /**
     * If returns true, this entry is skipped before scoring.
     * Use sparingly: prefer to encode soft signals in qualityScore.
     */
    hardSkipPredicate?: (ctx: ManifestContext) => boolean
}

/**
 * Canonical model-class key per provider that the manifest scores.
 * The selector resolves a concrete `(provider, model)` to its model-class entry
 * via this lookup.
 */
export const PROVIDER_DEFAULT_MODEL_CLASS: Partial<Record<ProviderKey, string>> = {
    openai: 'gpt-4o',
    anthropic: 'claude-sonnet-4-6',
    google: 'gemini-2.0-flash',
    deepseek: 'deepseek-v3',
    groq: 'llama-3.3-70b',
}

/** Convenience for tests + downstream introspection. */
export const MANIFEST_PROVIDERS: ProviderKey[] = [
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'groq',
]

/** Quality threshold: entries strictly below this are considered "low-quality" for Q2 hybrid routing. */
export const LOW_QUALITY_THRESHOLD = 3 as const

/**
 * Task types for which the system blocks + prompts the operator when no
 * candidate has qualityScore ≥ LOW_QUALITY_THRESHOLD (Q2 hybrid).
 * Other task types route through low-quality silently.
 */
export const HIGH_STAKES_TASK_TYPES: ReadonlySet<TaskType> = new Set<TaskType>([
    'planning',
    'codeGeneration',
    'extraction',
])

type ManifestTable = Record<TaskType, Partial<Record<ProviderKey, ManifestEntry>>>

const BASE: Capability[] = ['tool-calling', 'streaming']

/**
 * 5 providers × 8 task types = 40 entries.
 * qualityScore values reflect public leaderboard performance as of 2026-05.
 * Anthropic Sonnet leads code/planning; GPT-4o leads vision + general; Gemini
 * leads long-context; DeepSeek-v3 strong on summarization/extraction at low cost;
 * Llama-3.3-70b via Groq leads low-latency conversation/classification.
 */
export const MANIFEST: ManifestTable = {
    planning: {
        anthropic: { qualityScore: 5, capabilities: [...BASE, 'long-context-200k'], quirks: ['anthropic-429-respects-retry-after'] },
        openai: { qualityScore: 4, capabilities: [...BASE, 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'] },
        google: { qualityScore: 4, capabilities: [...BASE, 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'] },
        deepseek: { qualityScore: 3, capabilities: [...BASE], quirks: ['deepseek-slow-on-long-prompts'] },
        groq: { qualityScore: 2, capabilities: [...BASE, 'low-latency'], quirks: [] },
    },
    codeGeneration: {
        anthropic: { qualityScore: 5, capabilities: [...BASE, 'long-context-200k'], quirks: ['anthropic-429-respects-retry-after'] },
        openai: { qualityScore: 4, capabilities: [...BASE, 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'] },
        deepseek: { qualityScore: 4, capabilities: [...BASE], quirks: ['deepseek-slow-on-long-prompts'] },
        google: { qualityScore: 3, capabilities: [...BASE, 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'] },
        groq: { qualityScore: 2, capabilities: [...BASE, 'low-latency'], quirks: [] },
    },
    verification: {
        anthropic: { qualityScore: 5, capabilities: [...BASE, 'json-mode'], quirks: ['anthropic-429-respects-retry-after'] },
        openai: { qualityScore: 5, capabilities: [...BASE, 'json-mode', 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'] },
        google: { qualityScore: 3, capabilities: [...BASE, 'json-mode'], quirks: ['google-content-policy-returns-200-with-refusal-string'] },
        deepseek: { qualityScore: 3, capabilities: [...BASE], quirks: [] },
        groq: { qualityScore: 2, capabilities: [...BASE, 'low-latency'], quirks: [] },
    },
    summarization: {
        openai: { qualityScore: 4, capabilities: [...BASE], quirks: ['openai-no-retry-after'] },
        anthropic: { qualityScore: 4, capabilities: [...BASE], quirks: ['anthropic-429-respects-retry-after'] },
        deepseek: { qualityScore: 4, capabilities: [...BASE], quirks: [] },
        google: { qualityScore: 4, capabilities: [...BASE, 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'] },
        groq: { qualityScore: 3, capabilities: [...BASE, 'low-latency'], quirks: [] },
    },
    conversation: {
        openai: { qualityScore: 5, capabilities: [...BASE], quirks: ['openai-no-retry-after'] },
        anthropic: { qualityScore: 5, capabilities: [...BASE], quirks: ['anthropic-429-respects-retry-after'] },
        google: { qualityScore: 4, capabilities: [...BASE], quirks: ['google-content-policy-returns-200-with-refusal-string'] },
        groq: { qualityScore: 4, capabilities: [...BASE, 'low-latency'], quirks: [] },
        deepseek: { qualityScore: 3, capabilities: [...BASE], quirks: [] },
    },
    classification: {
        groq: { qualityScore: 4, capabilities: [...BASE, 'low-latency'], quirks: [] },
        openai: { qualityScore: 4, capabilities: [...BASE, 'json-mode'], quirks: ['openai-no-retry-after'] },
        anthropic: { qualityScore: 4, capabilities: [...BASE], quirks: ['anthropic-429-respects-retry-after'] },
        deepseek: { qualityScore: 3, capabilities: [...BASE], quirks: [] },
        google: { qualityScore: 3, capabilities: [...BASE], quirks: ['google-content-policy-returns-200-with-refusal-string'] },
    },
    logAnalysis: {
        google: { qualityScore: 5, capabilities: [...BASE, 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'] },
        anthropic: { qualityScore: 4, capabilities: [...BASE, 'long-context-200k'], quirks: ['anthropic-429-respects-retry-after'] },
        openai: { qualityScore: 4, capabilities: [...BASE], quirks: ['openai-no-retry-after'] },
        deepseek: { qualityScore: 3, capabilities: [...BASE, 'long-context-200k'], quirks: ['deepseek-slow-on-long-prompts'] },
        groq: { qualityScore: 2, capabilities: [...BASE, 'low-latency'], quirks: [] },
    },
    extraction: {
        openai: { qualityScore: 5, capabilities: [...BASE, 'json-mode', 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'] },
        anthropic: { qualityScore: 4, capabilities: [...BASE, 'json-mode'], quirks: ['anthropic-429-respects-retry-after'] },
        deepseek: { qualityScore: 4, capabilities: [...BASE], quirks: [] },
        google: { qualityScore: 3, capabilities: [...BASE, 'json-mode'], quirks: ['google-content-policy-returns-200-with-refusal-string'] },
        groq: { qualityScore: 3, capabilities: [...BASE, 'low-latency'], quirks: [] },
    },
}

/**
 * Look up the manifest entry for a (taskType, provider).
 * Returns undefined if the provider has no scored entry for this task.
 */
export function getManifestEntry(
    taskType: TaskType,
    provider: ProviderKey,
): ManifestEntry | undefined {
    return MANIFEST[taskType]?.[provider]
}
