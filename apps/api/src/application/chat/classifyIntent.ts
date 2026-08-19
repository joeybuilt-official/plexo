// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure intent-classification dispatch for the webchat message route.
 *
 * Extracted from `routes/chat.ts`. The heuristic pre-classifier lives in
 * `routes/chat-intent.ts` (`preClassifyIntent`); this module holds the two
 * pure steps that surround it:
 *
 *   1. `resolveHeuristicIntent` — map a heuristic result to a decided
 *      intent, or compute the `execDefault` to fall back to when the LLM
 *      classifier must run.
 *   2. `parseClassifyResponse` — parse the LLM classifier's free-text
 *      label ("TASK [COMPLEX]" / "PROJECT" / "MEMORY" / "CONVERSATION")
 *      into a typed intent + complexity flag, failing toward
 *      `execDefault` on an unrecognized label.
 *
 * No Express/Drizzle/SDK imports — the route supplies parsed inputs and
 * consumes the typed result. The HeuristicInput shape is structurally
 * compatible with `HeuristicIntent` from `chat-intent.ts` so the route can
 * pass that result through without an import edge from application → routes.
 */

export type Intent = 'TASK' | 'PROJECT' | 'MEMORY' | 'CONVERSATION'

/**
 * Structural match of `HeuristicIntent` from `routes/chat-intent.ts`.
 * Duplicated here so the application layer does not import from routes.
 */
export type HeuristicInput =
    | { kind: 'project' }
    | { kind: 'task'; isComplex: boolean }
    | { kind: 'memory' }
    | { kind: 'conversation' }
    | { kind: 'needsLlm'; hasTaskVerb: boolean }

export type ResolveHeuristicResult =
    | { kind: 'decided'; intent: Intent; isComplex: boolean }
    | { kind: 'needsLlm'; execDefault: 'TASK' | 'CONVERSATION' }

/**
 * Map a heuristic pre-classification to a decided intent, or defer to the
 * LLM classifier with the appropriate fail-toward-execution default.
 */
export function resolveHeuristicIntent(pre: HeuristicInput): ResolveHeuristicResult {
    if (pre.kind === 'project') return { kind: 'decided', intent: 'PROJECT', isComplex: true }
    if (pre.kind === 'task') return { kind: 'decided', intent: 'TASK', isComplex: pre.isComplex }
    if (pre.kind === 'memory') return { kind: 'decided', intent: 'MEMORY', isComplex: false }
    if (pre.kind === 'conversation') return { kind: 'decided', intent: 'CONVERSATION', isComplex: false }
    return { kind: 'needsLlm', execDefault: pre.hasTaskVerb ? 'TASK' : 'CONVERSATION' }
}

/**
 * Parse the LLM classifier's text response into a typed intent.
 *
 * Recognized labels are matched case-insensitively by prefix
 * ("TASK", "PROJECT", "MEMORY", "CONVERSATION"); an unrecognized label
 * falls back to `execDefault`. A second token starting with "COMPLEX"
 * marks the task as complex. Empty/whitespace text falls back to
 * `execDefault` with `isComplex: false`.
 */
export function parseClassifyResponse(
    text: string | undefined | null,
    execDefault: 'TASK' | 'CONVERSATION',
): { intent: Intent; isComplex: boolean } {
    const trimmed = text?.trim() ?? ''
    const upperText = trimmed.toUpperCase()
    const parts = trimmed.split(/\s+/)

    let intent: Intent = execDefault
    if (upperText.startsWith('TASK')) intent = 'TASK'
    else if (upperText.startsWith('PROJECT')) intent = 'PROJECT'
    else if (upperText.startsWith('MEMORY')) intent = 'MEMORY'
    else if (upperText.startsWith('CONVERSATION')) intent = 'CONVERSATION'

    let isComplex = false
    if (parts[1]?.toUpperCase().startsWith('COMPLEX')) isComplex = true

    return { intent, isComplex }
}