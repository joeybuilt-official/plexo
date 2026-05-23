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
    | 'ollama-cloud-managed-pool-rate-limit'
    | 'ollama-cloud-cold-start-latency'

export interface ManifestContext {
    workspaceId: string | undefined
    taskType: TaskType
    /** ID of the model that would run if this entry is chosen (post-resolution). */
    modelId: string | undefined
}

export interface ManifestEntry {
    /** 1–5; 5 = best-in-class on this taskType. Static prior from public leaderboard data; refined at runtime by stats.ts. */
    priorScore: 1 | 2 | 3 | 4 | 5
    capabilities: Capability[]
    quirks: ProviderQuirk[]
    /** ISO date (YYYY-MM-DD) of last manual review; pre-mortem F1 fallback (a) — entries older than 180d trigger a review alert. */
    lastValidatedAt: string
    /**
     * If returns true, this entry is skipped before scoring.
     * Use sparingly: prefer to encode soft signals in priorScore.
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
    ollama_cloud: 'gpt-oss:20b-cloud',
}

/** Convenience for tests + downstream introspection. */
export const MANIFEST_PROVIDERS: ProviderKey[] = [
    'openai',
    'anthropic',
    'google',
    'deepseek',
    'groq',
    'ollama_cloud',
]

/** Quality threshold: entries strictly below this are considered "low-quality" for Q2 hybrid routing. */
export const LOW_QUALITY_THRESHOLD = 3 as const

/**
 * Task types for which the system blocks + prompts the operator when no
 * candidate has priorScore ≥ LOW_QUALITY_THRESHOLD (Q2 hybrid).
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
 * 9 task types × up to 6 providers. ADR 0012 §C6 first-cut covers the 6 in-scope
 * task types (planning, extraction, classification, conversation, judging,
 * summarization) at 6 providers each; codeGeneration/verification/logAnalysis
 * retain the 5-provider shape (ollama_cloud added in a later sweep).
 * priorScore values reflect public leaderboard performance as of 2026-05.
 * Anthropic Sonnet leads code/planning/judging; GPT-4o leads extraction;
 * Gemini leads long-context + logAnalysis; DeepSeek-v3 strong on summarization
 * at low cost; Llama-3.3-70b via Groq leads low-latency conversation/classification;
 * gpt-oss:20b via ollama_cloud is the managed-pool fallback (low priorScore,
 * never lead — used when an installed-provider quality bar is unmet).
 */
export const MANIFEST: ManifestTable = {
    planning: {
        anthropic: { priorScore: 5, capabilities: [...BASE, 'long-context-200k'], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        openai: { priorScore: 4, capabilities: [...BASE, 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'], lastValidatedAt: '2026-05-13' },
        google: { priorScore: 4, capabilities: [...BASE, 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 3, capabilities: [...BASE], quirks: ['deepseek-slow-on-long-prompts'], lastValidatedAt: '2026-05-13' },
        groq: { priorScore: 3, capabilities: [...BASE, 'low-latency'], quirks: [], lastValidatedAt: '2026-05-23' },
        ollama_cloud: { priorScore: 2, capabilities: [...BASE], quirks: ['ollama-cloud-managed-pool-rate-limit', 'ollama-cloud-cold-start-latency'], lastValidatedAt: '2026-05-13' },
    },
    codeGeneration: {
        anthropic: { priorScore: 5, capabilities: [...BASE, 'long-context-200k'], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        openai: { priorScore: 4, capabilities: [...BASE, 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 4, capabilities: [...BASE], quirks: ['deepseek-slow-on-long-prompts'], lastValidatedAt: '2026-05-13' },
        google: { priorScore: 3, capabilities: [...BASE, 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        groq: { priorScore: 3, capabilities: [...BASE, 'low-latency'], quirks: [], lastValidatedAt: '2026-05-23' },
    },
    verification: {
        anthropic: { priorScore: 5, capabilities: [...BASE, 'json-mode'], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        openai: { priorScore: 5, capabilities: [...BASE, 'json-mode', 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'], lastValidatedAt: '2026-05-13' },
        google: { priorScore: 3, capabilities: [...BASE, 'json-mode'], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 3, capabilities: [...BASE], quirks: [], lastValidatedAt: '2026-05-13' },
        groq: { priorScore: 2, capabilities: [...BASE, 'low-latency'], quirks: [], lastValidatedAt: '2026-05-13' },
    },
    summarization: {
        openai: { priorScore: 4, capabilities: [...BASE], quirks: ['openai-no-retry-after'], lastValidatedAt: '2026-05-13' },
        anthropic: { priorScore: 4, capabilities: [...BASE], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 4, capabilities: [...BASE], quirks: [], lastValidatedAt: '2026-05-13' },
        google: { priorScore: 4, capabilities: [...BASE, 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        groq: { priorScore: 3, capabilities: [...BASE, 'low-latency'], quirks: [], lastValidatedAt: '2026-05-13' },
        ollama_cloud: { priorScore: 3, capabilities: [...BASE], quirks: ['ollama-cloud-managed-pool-rate-limit'], lastValidatedAt: '2026-05-13' },
    },
    conversation: {
        openai: { priorScore: 5, capabilities: [...BASE], quirks: ['openai-no-retry-after'], lastValidatedAt: '2026-05-13' },
        anthropic: { priorScore: 5, capabilities: [...BASE], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        google: { priorScore: 4, capabilities: [...BASE], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        groq: { priorScore: 4, capabilities: [...BASE, 'low-latency'], quirks: [], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 3, capabilities: [...BASE], quirks: [], lastValidatedAt: '2026-05-13' },
        ollama_cloud: { priorScore: 3, capabilities: [...BASE], quirks: ['ollama-cloud-managed-pool-rate-limit', 'ollama-cloud-cold-start-latency'], lastValidatedAt: '2026-05-13' },
    },
    classification: {
        groq: { priorScore: 4, capabilities: [...BASE, 'low-latency'], quirks: [], lastValidatedAt: '2026-05-13' },
        openai: { priorScore: 4, capabilities: [...BASE, 'json-mode'], quirks: ['openai-no-retry-after'], lastValidatedAt: '2026-05-13' },
        anthropic: { priorScore: 4, capabilities: [...BASE], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 3, capabilities: [...BASE], quirks: [], lastValidatedAt: '2026-05-13' },
        google: { priorScore: 3, capabilities: [...BASE], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        ollama_cloud: { priorScore: 3, capabilities: [...BASE], quirks: ['ollama-cloud-managed-pool-rate-limit'], lastValidatedAt: '2026-05-13' },
    },
    logAnalysis: {
        google: { priorScore: 5, capabilities: [...BASE, 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        anthropic: { priorScore: 4, capabilities: [...BASE, 'long-context-200k'], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        openai: { priorScore: 4, capabilities: [...BASE], quirks: ['openai-no-retry-after'], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 3, capabilities: [...BASE, 'long-context-200k'], quirks: ['deepseek-slow-on-long-prompts'], lastValidatedAt: '2026-05-13' },
        groq: { priorScore: 2, capabilities: [...BASE, 'low-latency'], quirks: [], lastValidatedAt: '2026-05-13' },
    },
    extraction: {
        openai: { priorScore: 5, capabilities: [...BASE, 'json-mode', 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'], lastValidatedAt: '2026-05-13' },
        anthropic: { priorScore: 4, capabilities: [...BASE, 'json-mode'], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 4, capabilities: [...BASE], quirks: [], lastValidatedAt: '2026-05-13' },
        google: { priorScore: 3, capabilities: [...BASE, 'json-mode'], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        groq: { priorScore: 3, capabilities: [...BASE, 'low-latency'], quirks: [], lastValidatedAt: '2026-05-13' },
        ollama_cloud: { priorScore: 2, capabilities: [...BASE], quirks: ['ollama-cloud-managed-pool-rate-limit'], lastValidatedAt: '2026-05-13' },
    },
    judging: {
        anthropic: { priorScore: 5, capabilities: [...BASE, 'json-mode'], quirks: ['anthropic-429-respects-retry-after'], lastValidatedAt: '2026-05-13' },
        openai: { priorScore: 5, capabilities: [...BASE, 'json-mode', 'function-calling-strict'], quirks: ['openai-no-retry-after', 'openai-strict-json-mode'], lastValidatedAt: '2026-05-13' },
        google: { priorScore: 4, capabilities: [...BASE, 'json-mode', 'long-context-1m'], quirks: ['google-content-policy-returns-200-with-refusal-string'], lastValidatedAt: '2026-05-13' },
        deepseek: { priorScore: 3, capabilities: [...BASE], quirks: [], lastValidatedAt: '2026-05-13' },
        groq: { priorScore: 3, capabilities: [...BASE, 'low-latency', 'json-mode'], quirks: [], lastValidatedAt: '2026-05-13' },
        ollama_cloud: { priorScore: 2, capabilities: [...BASE], quirks: ['ollama-cloud-managed-pool-rate-limit'], lastValidatedAt: '2026-05-13' },
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
