// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Deliverable/task vocabulary — the single source of truth for "does this
 * request ask for a produced deliverable?".
 *
 * Three layers independently decided this and drifted apart, which produced a
 * real bug: chat classified "make a snake game" as TASK and queued it, then the
 * executor's own (different) verb list re-classified it as CONVERSATION and
 * stripped every tool — including `write_asset` — so the model dumped raw code
 * into the chat reply and no artifact (no viewable/playable link) was ever
 * created. The chat layer knew `make`; the executor and the fast-path planner
 * did not.
 *
 * Framework-free (ADR-0045): pure regex + helpers, no IO. Every layer that needs
 * to answer the question imports from here so the lists cannot drift again.
 */

/**
 * Imperative verbs that ask for a produced artifact. A request containing one of
 * these is a DELIVERABLE request — it must keep its tools (so `write_asset` runs
 * and the user gets something to view), never be treated as chit-chat.
 *
 * Includes the "make/draft/compose"-style verbs that were missing before; the
 * word-boundary match keeps `create`/`make` from firing inside other words.
 */
export const DELIVERABLE_VERB_RE =
    /\b(make|build|create|write|draft|compose|design|generate|produce|implement|develop|code|program|synthesize|summarize|summarise|translate|rewrite|redraft|edit|fix|update|refactor|optimize|optimi[sz]e|convert|render|draw|illustrate|mock\s*up|prototype|add|remove|delete|install|configure|migrate|deploy|run|execute|send|post|schedule)\b/i

/** True when the text contains an imperative deliverable verb. */
export function hasDeliverableVerb(text: string): boolean {
    return DELIVERABLE_VERB_RE.test(text)
}

/**
 * A short, self-contained deliverable request — "make a snake game", "write a
 * haiku", "draft a cold email". These are exactly the one-step, model-knows-it
 * tasks that must go straight to `write_asset` and must NOT be misclassified as
 * conversation. Kept deliberately narrow: a long or multi-clause request may
 * still be a deliverable, but it deserves the planner rather than the fast path.
 */
export function isSelfContainedDeliverable(text: string): boolean {
    const t = text.trim()
    if (!t) return false
    if (!hasDeliverableVerb(t)) return false
    // A question that merely asks *about* something is still conversational
    // unless it carries a deliverable verb (handled above) — no extra rule.
    return true
}
