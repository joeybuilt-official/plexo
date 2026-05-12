// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Progress projection engine — transforms raw ProgressEvents into
 * channel-appropriate output. One engine, pluggable rules per channel.
 *
 * Pure function: no side effects, no I/O. Channels call this to
 * decide what to render and how.
 */

import type { ProgressEvent, ProgressEventType } from './types.js'
import {
    COMPACT_PROJECTION,
    NORMAL_PROJECTION,
    VERBOSE_PROJECTION,
    type ProjectionConfig,
} from './types.js'

export type ChannelType = 'telegram' | 'slack' | 'discord' | 'web-default' | 'web-glass-cockpit' | 'embedded'

export interface ProjectedOutput {
    /** Rendered text for this channel */
    text: string
    /** Whether this should trigger an edit (vs new message) */
    isUpdate: boolean
    /** Whether this is a terminal event (task done/failed) */
    isTerminal: boolean
    /** Original event type */
    eventType: ProgressEventType
}

// ── Voice rules ─────────────────────────────────────────────────────────────

const FORBIDDEN_STARTS = ['sorry', 'apologies', 'i apologize']
const CONTENT_FREE = ['still working', 'one moment', 'please wait', 'just a moment', 'hang on', 'working on it']
const LAZY_VOICE = ['i\'m going to', 'i will', 'let me', 'i\'ll']

function enforceVoice(content: string, fallback: string): string {
    const lower = content.toLowerCase().trim()

    // Reject forbidden starts
    for (const start of FORBIDDEN_STARTS) {
        if (lower.startsWith(start)) return fallback || 'Processing'
    }

    // Reject content-free messages
    for (const phrase of CONTENT_FREE) {
        if (lower.includes(phrase)) return fallback || 'Processing'
    }

    // Rewrite lazy voice to present tense (best effort)
    let result = content
    for (const phrase of LAZY_VOICE) {
        if (lower.startsWith(phrase)) {
            // Strip the lazy prefix: "I'm going to read the file" → "Reading the file"
            result = content.slice(phrase.length).trim()
            // Capitalize and add -ing if it starts with a verb
            if (result.length > 0) {
                result = result[0]!.toUpperCase() + result.slice(1)
            }
            break
        }
    }

    return result || fallback || 'Processing'
}

// ── Channel config ──────────────────────────────────────────────────────────

const CHANNEL_CONFIG: Record<ChannelType, ProjectionConfig> = {
    'telegram': COMPACT_PROJECTION,
    'slack': COMPACT_PROJECTION,
    'discord': COMPACT_PROJECTION,
    'web-default': NORMAL_PROJECTION,
    'web-glass-cockpit': VERBOSE_PROJECTION,
    'embedded': NORMAL_PROJECTION,
}

// ── Projection ──────────────────────────────────────────────────────────────

/**
 * Project a ProgressEvent for a specific channel.
 * Returns null if the event should be suppressed for this channel.
 */
export function projectEvent(event: ProgressEvent, channel: ChannelType): ProjectedOutput | null {
    const config = CHANNEL_CONFIG[channel] ?? NORMAL_PROJECTION

    // Filter by event type
    if (!config.includeTypes.has(event.type)) return null

    // Build fallback from structured data
    const fallback = event.tool?.displayAction
        ?? event.phase?.label
        ?? event.type

    // Enforce voice rules
    const text = enforceVoice(event.content, fallback)

    // Truncate
    const truncated = text.length > config.maxContentLength
        ? text.slice(0, config.maxContentLength) + '...'
        : text

    // Format for channel
    const isTerminal = event.type === 'phase_complete' && event.phase?.index === (event.phase?.total ?? 1) - 1
    const isUpdate = event.type !== 'status' // most events update the existing message

    return {
        text: truncated,
        isUpdate,
        isTerminal,
        eventType: event.type,
    }
}

/**
 * Format a compact progress line for messaging channels (Telegram, Slack, Discord).
 * Shows phase progress if available, otherwise the content.
 */
export function formatCompactProgress(event: ProgressEvent): string {
    if (event.phase && event.phase.total > 1) {
        const prefix = event.type === 'phase_complete' ? '✓' : '📍'
        return `${prefix} Phase ${event.phase.index + 1}/${event.phase.total}: ${event.phase.label}`
    }

    if (event.type === 'error') {
        return `⚠️ ${event.content}`
    }

    return event.content
}
