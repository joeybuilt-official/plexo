// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure helpers for Phase 4 channel state notifications.
 *
 * Lives separate from channel-delivery.ts so it can be imported without
 * pulling in the agent stack (channel-delivery → channel-ai → agent-loop
 * → planner / executor / etc.). This keeps the test surface narrow and
 * lets unit tests run without configuring every transitive @plexo/agent
 * subpath alias.
 *
 * No DB calls, no network, no agent imports — only string formatting and
 * regex classification.
 */

import type { EscalationSummary } from '@plexo/agent/tasks/types'

// ── Channels that support inbound CONFIRM/CANCEL replies ─────────────────────
// Web does not — its confirmation surface is the SSE-driven /app/approvals view.
const CONFIRMATION_CHANNELS = new Set(['telegram', 'slack', 'discord'])

export function channelSupportsConfirmation(channel: string | undefined): boolean {
    return !!channel && CONFIRMATION_CHANNELS.has(channel)
}

// ── State→message formatter ──────────────────────────────────────────────────

export type TaskTransitionState =
    | 'planning'
    | 'awaiting_confirmation'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'step_complete'

export interface TaskTransitionInput {
    state: TaskTransitionState
    /** User-facing task title or description (truncated for display). */
    title?: string
    /** For awaiting_confirmation: number of one-way-door steps the user is being asked to approve. */
    stepCount?: number
    /**
     * Short code shown to the user with CONFIRM/CANCEL prompts. Caller derives
     * this from the OWD approval id (typically the first 6 hex chars of the
     * 24-char id). When the user supplies it back in their reply, it's used
     * to disambiguate concurrent pending approvals in the same chat.
     */
    confirmationCode?: string
    /** For failed: 4-field escalation summary (Krishnamurthy). */
    summary?: EscalationSummary
    /** For completed: short single-line outcome the user sees. */
    completedSummary?: string
    /** For cancelled: optional reason string. */
    cancelReason?: string
    /** Set true to emit step_complete messages. Off by default. */
    verbose?: boolean
}

const TITLE_MAX = 100

function clipTitle(title: string | undefined): string {
    const t = (title ?? '').trim()
    if (!t) return 'your task'
    return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1) + '…' : t
}

export function formatTaskStateMessage(input: TaskTransitionInput): string | null {
    switch (input.state) {
        case 'planning':
            return `📝 Working on a plan for: *${clipTitle(input.title)}*`
        case 'awaiting_confirmation': {
            const n = input.stepCount && input.stepCount > 0 ? input.stepCount : 1
            const noun = `${n} irreversible step${n === 1 ? '' : 's'}`
            const code = input.confirmationCode
            const replyLine = code
                ? `Reply *CONFIRM ${code}* to proceed or *CANCEL ${code}* to abort.`
                : `Reply *CONFIRM* to proceed or *CANCEL* to abort.`
            return `⏸️ *${clipTitle(input.title)}* is ready, but it would do ${noun}.\n${replyLine}`
        }
        case 'completed':
            return `✅ ${input.completedSummary?.trim() || 'Task complete.'}`
        case 'failed': {
            const s = input.summary
            if (!s) return `❌ Task failed.`
            const recoverable = s.recoverable
                ? `_(recoverable — you can resume from where it stopped)_`
                : `_(not recoverable — restart needed)_`
            return [
                `❌ *${s.what}*`,
                ``,
                `*Why:* ${s.why}`,
                `*Next:* ${s.action}`,
                recoverable,
            ].join('\n')
        }
        case 'cancelled':
            return input.cancelReason
                ? `🚫 Task cancelled: ${input.cancelReason}`
                : `🚫 Task cancelled.`
        case 'step_complete':
            return input.verbose ? `Step complete.` : null
        default:
            return null
    }
}

// ── Inbound CONFIRM / CANCEL classification ──────────────────────────────────

// Strict verb match. Loose tokens (yes/y/ok/no/n/stop) are intentionally
// dropped — false-positive risk in normal conversation (a casual "yes please"
// in an unrelated thread) outweighs the small UX win. The awaiting_confirmation
// prompt explicitly tells the user "Reply CONFIRM" or "Reply CANCEL".
const CONFIRM_RE = /^\s*(confirm(ed)?|approve(d)?)\b/i
const CANCEL_RE = /^\s*(cancel(led)?|reject(ed)?|abort(ed)?)\b/i

export function classifyConfirmCancel(text: string): 'confirm' | 'cancel' | null {
    if (CONFIRM_RE.test(text)) return 'confirm'
    if (CANCEL_RE.test(text)) return 'cancel'
    return null
}

/**
 * Extract a 6-char hex code from the user's reply (case-insensitive). The
 * awaiting_confirmation prompt suggests "CONFIRM <code>"; this code maps
 * to the first 6 chars of the OWD approval id and disambiguates between
 * multiple concurrent pending approvals in the same chat. When absent, the
 * caller falls back to the most-recent awaiting_approval task.
 *
 * Lookarounds require non-word boundaries on both sides — so "abc" (3) and
 * "abcdefg" (7, where 'g' is a word char) both miss. This catches typo
 * cases where the user typed too many or too few characters; they can
 * retry rather than us silently picking the wrong code prefix.
 */
export function extractConfirmationCode(text: string): string | null {
    const m = text.match(/(?<!\w)([0-9a-f]{6})(?!\w)/i)
    return m?.[1] ? m[1].toLowerCase() : null
}
