// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * DD-5: pure helpers for per-conversation model + system-prompt overrides.
 * Kept side-effect-free so they can be unit-tested without a DB or provider
 * stack. The chat route threads the persisted overrides through these and
 * into `routeAndCall` / `streamText`.
 */

/**
 * Resolve the effective model override for a turn.
 *
 * Precedence: an explicit per-turn value (sent in the POST body by the UI
 * when the operator just changed it) wins over the persisted latest-row
 * override (copy-forward from a prior turn). `undefined` = no override →
 * the caller falls back to the agent's resolved model.
 *
 * Returns `<providerType>/<modelId>` or bare `<modelId>` as-is — the same
 * contract `routeAndCall.modelIdOverride` accepts.
 */
export function resolveModelOverride(
    perTurn: string | null | undefined,
    persisted: string | null | undefined,
): string | undefined {
    const a = normalizeOverride(perTurn)
    if (a) return a
    return normalizeOverride(persisted) ?? undefined
}

/**
 * Compose the effective system prompt. Non-empty override is PREPENDED to
 * the compiled behavior prompt so the operator's tuning layers on top of
 * identity/capabilities without losing them. Empty/null = compiled prompt
 * unchanged (current behavior pre-DD-5).
 */
export function composeSystemPrompt(
    compiledPrompt: string,
    override: string | null | undefined,
): string {
    const o = normalizeOverride(override)
    if (!o) return compiledPrompt
    return `${o}\n\n${compiledPrompt}`
}

function normalizeOverride(v: string | null | undefined): string | null {
    if (v == null) return null
    const trimmed = typeof v === 'string' ? v.trim() : v
    return trimmed.length > 0 ? trimmed : null
}