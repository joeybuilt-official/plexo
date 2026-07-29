// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * QuickSend routing heuristic.
 *
 * The dashboard composer used to POST every submission to
 * `/api/v1/tasks` as a full automation task — cheap for "Build me a
 * CRM", absurd for "You working?". The server already has a trivial-
 * message fastpath on `/api/v1/chat/message` that answers greetings
 * and status pings in ~1-2s. This helper is the client-side gate that
 * decides which endpoint a given draft should hit.
 *
 * Intentionally conservative and dependency-free:
 *   - cap on length (chat fastpath is for short messages only)
 *   - block any draft that mentions a project-creation verb so the
 *     legitimate "build me X" path keeps routing to /tasks
 *
 * Pure function — no React, no DOM. Safe to import from vitest.
 */

/** Max trimmed length for a QuickSend draft to qualify as chat-bound. */
export const QUICK_SEND_CHAT_MAX_LEN = 200

/**
 * Verbs that strongly imply the user wants to spin up a full task /
 * project / artifact. Case-insensitive, matched as whole words so
 * "created_at" in a stray log line doesn't trigger.
 */
const PROJECT_VERBS = [
    'build',
    'create',
    'make',
    'develop',
    'scaffold',
    'implement',
    'generate',
    'design',
    'write',
    'refactor',
    'deploy',
    'set up',
    'setup',
] as const

const PROJECT_VERB_RE = new RegExp(
    `\\b(${PROJECT_VERBS.map(v => v.replace(/ /g, '\\s+')).join('|')})\\b`,
    'i',
)

/**
 * Returns true when a draft should be routed through the chat
 * fastpath endpoint instead of the full task executor.
 *
 * Rules:
 *   1. Empty / whitespace → false (caller handles empty submissions).
 *   2. Longer than QUICK_SEND_CHAT_MAX_LEN after trim → false.
 *   3. Contains a project-creation verb → false.
 *   4. Otherwise → true.
 */
export function looksLikeChat(message: string | null | undefined): boolean {
    if (!message) return false
    const trimmed = message.trim()
    if (trimmed.length === 0) return false
    if (trimmed.length > QUICK_SEND_CHAT_MAX_LEN) return false
    if (PROJECT_VERB_RE.test(trimmed)) return false
    return true
}
