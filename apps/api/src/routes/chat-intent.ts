// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure heuristic pre-classifier for webchat intent. Returns a decided intent
 * for unambiguous messages, or `{ kind: 'needsLlm' }` to defer to the LLM
 * classifier. Extracted from chat.ts so the routing rules are unit-testable.
 *
 * Key rule (this was a bug): a trailing '?' signals CONVERSATION only when the
 * message has NO task verb. Previously any '?' forced CONVERSATION, so
 * "Build me a flappy bird game?" was silently routed to chat and never executed.
 *
 * The caller (chat.ts) keeps the LLM classifier and the `forceConversation`
 * gate; on an ambiguous message it should fail TOWARD execution when
 * `hasTaskVerb` is true rather than defaulting to chat.
 *
 * Deliverable rule: a message that asks for a SOFTWARE/INTERACTIVE artifact
 * ("make a snake game", "build a landing page", "write a python script") is
 * decided TASK here, before the LLM classifier runs. The classifier was
 * observed labelling "make a snake game" as CONVERSATION (its verdict wins over
 * the `execDefault`), which queued nothing and produced no artifact. The
 * vocabulary lives in `@plexo/domain/deliverable-verbs` so chat, the executor,
 * and the planner cannot drift apart again (the #199 regression).
 */

import { isSoftwareDeliverableRequest } from '@plexo/domain'

export type HeuristicIntent =
    | { kind: 'project' }
    | { kind: 'task'; isComplex: boolean }
    | { kind: 'memory' }
    | { kind: 'conversation' }
    | { kind: 'needsLlm'; hasTaskVerb: boolean }

const TASK_VERB_RE =
    /\b(create|write|fix|update|install|configure|implement|migrate|generate|refactor|optimize|build|make|add|connect|remove|delete|send|post|schedule|run|execute)\b/i

export function preClassifyIntent(message: string): HeuristicIntent {
    const trimmedMsg = message.trim()
    const lower = trimmedMsg.toLowerCase()
    const wordCount = trimmedMsg.split(/\s+/).filter(Boolean).length

    // Explicit project intent — honor what the user literally said.
    const isExplicitProject =
        /\b(start|kick\s*off|kickoff|begin|create|spin\s*up|set\s*up|setup)\s+(a\s+|an\s+|the\s+|another\s+|new\s+)?(new\s+)?project\b/i.test(lower) ||
        /\bnew\s+project\s*[:\-]/i.test(lower) ||
        /\blet'?s\s+(start|build|create|make|kick\s*off|begin)\s+(a\s+|an\s+|the\s+|another\s+)?(new\s+)?project\b/i.test(lower) ||
        /^project\s*[:\-]\s+/i.test(trimmedMsg)
    if (isExplicitProject) return { kind: 'project' }

    // Ops commands — always TASK, even if short.
    const isOpsCommand =
        /\b(restart|deploy|rebuild|redeploy|stop|docker|container|compose|logs|status|health.?check|pull|push|git\s|caddy|nginx|dns|certificate|cert|backup|migrate|rollback)\b/i.test(lower)
    if (isOpsCommand) return { kind: 'task', isComplex: false }

    // Memory instructions take precedence over the conversation catch-all.
    const isObviousMemory = /^(remember|always|never|don't|dont)\s/i.test(lower)
    if (isObviousMemory) return { kind: 'memory' }

    // Software deliverable — decided here so the LLM classifier can never
    // downgrade "make a snake game" to CONVERSATION (which queues no task and
    // writes no artifact). Requires a deliverable VERB and a software-artifact
    // NOUN, so "what is a web app?" (verb-less) stays conversational.
    if (isSoftwareDeliverableRequest(trimmedMsg)) {
        return { kind: 'task', isComplex: false }
    }

    const hasTaskVerb = TASK_VERB_RE.test(lower)
    const endsWithQuestion = /\?$/.test(trimmedMsg)
    const isObviousConversation =
        (wordCount <= 5 && !hasTaskVerb) ||
        /^(hi|hey|hello|yo|sup|what|how|why|when|where|who|can you|do you|are you|tell me|thanks|thank you|ok|okay|sure|yes|no|yeah|nah|again|try again|test)/i.test(lower) ||
        // Questions are conversational ONLY when there is no task verb — a
        // build request phrased as a question ("Build me a game?") must execute.
        (!hasTaskVerb && endsWithQuestion) ||
        /^(remember|always|never|don't|make sure)\s/i.test(lower)
    if (isObviousConversation) return { kind: 'conversation' }

    return { kind: 'needsLlm', hasTaskVerb }
}
