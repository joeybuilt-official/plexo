// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Trivial-message fastpath detection.
 *
 * A "trivial" message is a short greeting or status check that should
 * bypass the intent classifier, the executor, tool loading, memory
 * recall, and the introspection snapshot — all of which together added
 * ~40s of latency for simple messages like "You working?".
 *
 * The detector is intentionally conservative:
 *   - messages longer than MAX_TRIVIAL_LEN are never trivial
 *   - the patterns are anchored and whitespace-tolerant
 *   - anything remotely ambiguous (questions about *anything* except
 *     the agent's own liveness) is NOT trivial and takes the normal path
 *
 * Keep this file tiny and dependency-free so it can be imported from
 * the hot path without bloat.
 */

/** Max trimmed length for a message to qualify as trivial. */
export const MAX_TRIVIAL_LEN = 30

/** Regexes: any match → trivial. */
const TRIVIAL_PATTERNS: RegExp[] = [
    /^(hi|hello|hey|yo|sup|howdy)\b[\s!.,?]*$/i,
    /^(you|are you|r u|u)\s+(working|online|alive|there|here|up|good|ready|ok|okay)\s*\??\s*$/i,
    /^(test|ping|status|alive|online\??|working\??)\s*\??\s*$/i,
    /^(thanks|thank you|thx|ty|cheers)\b[\s!.,?]*$/i,
    /^(ok|okay|cool|nice|got it|sounds good|noted|gotcha|k)\b[\s!.,?]*$/i,
    /^(good morning|good afternoon|good evening|good night|gm|gn)\b[\s!.,?]*$/i,
]

export function isTrivialMessage(msg: string | null | undefined): boolean {
    if (!msg) return false
    const trimmed = msg.trim()
    if (trimmed.length === 0 || trimmed.length > MAX_TRIVIAL_LEN) return false
    return TRIVIAL_PATTERNS.some(re => re.test(trimmed))
}

/**
 * Tight system prompt for the fastpath model call. Intentionally
 * short — the whole point is to minimize tokens, latency, and
 * surface area for drift.
 */
export const TRIVIAL_SYSTEM_PROMPT =
    `You are {agentName}. The user sent a brief status/greeting message. ` +
    `Respond in one short, friendly sentence (max ~15 words). ` +
    `If the user is asking whether you are working/alive/online, confirm affirmatively. ` +
    `Do not call any tools. Do not ask follow-up questions. Do not add caveats.`

/** Render the system prompt with a specific agent display name. */
export function buildTrivialSystemPrompt(agentName: string): string {
    return TRIVIAL_SYSTEM_PROMPT.replace('{agentName}', agentName || 'Plexo')
}

/**
 * Pinned model ID for the trivial-message fastpath.
 *
 * Rationale: the fastpath used to route through `withFallback(..., 'classification', ...)`
 * and rely on the deepseek-reasoner → deepseek-chat auto-swap in registry.ts
 * to keep latency low. That's fragile — a workspace that overrides the
 * `classification` tier to a reasoning model would silently regress the
 * fastpath back to 30-90s. Pinning an explicit non-reasoning model here
 * makes the fastpath model choice independent of workspace configuration.
 *
 * The value is a plain model ID (no provider prefix). Whichever provider is
 * primary on the workspace gets it passed as the per-tier override at call
 * time. `deepseek-chat` is cheap, fast, tool-capable, and ships with a free
 * tier on most configs — a safe default. If the workspace has no deepseek
 * key, `withFallback` still walks the fallback chain and `buildModel` will
 * pick the per-provider default from PROVIDER_DEFAULT_MODELS (which is also
 * always a non-reasoning chat model).
 */
export const FASTPATH_MODEL: string = 'deepseek-chat'
