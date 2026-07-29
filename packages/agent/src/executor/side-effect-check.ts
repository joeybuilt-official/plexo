// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Side-effect verification for the quality judge.
 *
 * When a user asks the agent to perform a real-world action via a connected
 * service (create a Notion page, send an email, open a GitHub issue, …), the
 * agent MUST invoke the matching tool. Describing what it would do, outlining
 * the steps, or saying "I will create..." is not acceptable.
 *
 * This module is pure — no DB, no network — so it can be unit-tested in
 * isolation without pulling the executor's full dependency graph.
 */

/**
 * Map of high-signal action verbs to the connected-service tool namespaces
 * they imply. When the user says "create a Notion doc", we expect a call to
 * a `notion__*` tool. Generous by design — any namespace hit counts.
 */
const ACTION_TOOL_HINTS: Array<{
    pattern: RegExp
    expectedNamespaces: string[]
    label: string
}> = [
    { pattern: /\b(create|make|write|draft|add)\b[^.]*\bnotion\b/i, expectedNamespaces: ['notion__'], label: 'Notion' },
    { pattern: /\bnotion\b[^.]*\b(create|make|write|draft|add|update|page|doc|database)\b/i, expectedNamespaces: ['notion__'], label: 'Notion' },
    { pattern: /\b(send|draft|compose)\b[^.]*\b(email|gmail|mail)\b/i, expectedNamespaces: ['gmail__', 'sendgrid__', 'resend__', 'postmark__', 'mailgun__', 'outlook__', 'email__', 'smtp'], label: 'Email' },
    { pattern: /\b(send|post)\b[^.]*\bslack\b/i, expectedNamespaces: ['slack__', 'slack_'], label: 'Slack' },
    { pattern: /\b(post|tweet)\b[^.]*\b(twitter|tweet|x\.com)\b/i, expectedNamespaces: ['twitter__', 'x__'], label: 'Twitter/X' },
    { pattern: /\b(create|add|update|close|comment on)\b[^.]*\b(github|issue|pull request|pr)\b/i, expectedNamespaces: ['github__', 'gh__'], label: 'GitHub' },
    { pattern: /\b(create|add|update|move)\b[^.]*\b(linear|jira|asana|trello|clickup|monday)\b/i, expectedNamespaces: ['linear__', 'jira__', 'asana__', 'trello__', 'clickup__', 'monday__'], label: 'Project tracker' },
    { pattern: /\b(create|add|update|schedule)\b[^.]*\b(calendar|event|meeting)\b/i, expectedNamespaces: ['gcal_', 'gcal__', 'calendar__', 'outlook__'], label: 'Calendar' },
    { pattern: /\b(create|add|update|write)\b[^.]*\b(google (doc|docs|sheet|sheets|drive))\b/i, expectedNamespaces: ['gdrive__', 'gdocs__', 'gsheets__', 'google__', 'drive__'], label: 'Google Workspace' },
    { pattern: /\b(create|add|update)\b[^.]*\b(airtable)\b/i, expectedNamespaces: ['airtable__'], label: 'Airtable' },
    { pattern: /\b(upload|create|store|put)\b[^.]*\b(s3|bucket|dropbox|one ?drive)\b/i, expectedNamespaces: ['s3__', 'dropbox__', 'onedrive__'], label: 'File storage' },
    { pattern: /\b(create|charge|refund|invoice|subscribe)\b[^.]*\b(stripe|payment|customer)\b/i, expectedNamespaces: ['stripe__'], label: 'Stripe' },
]

/** Text markers suggesting the agent was describing future/hypothetical action. */
const HYPOTHETICAL_PATTERNS = [
    /\bI (will|would|can|could|should|am going to)\b/i,
    /\bI['’]ll\b/i,
    /\bI['’]d\b/i,
    /\bwould (be|look like|work)\b/i,
    /\bhere['’]s (what|how) I would\b/i,
    /\bto create (the|a|an)\b.+\byou (can|could|would)\b/i,
    /\bonce (you|I) (have|provide|confirm|approve)\b/i,
]

export interface SideEffectCheck {
    penalised: boolean
    reason?: string
    expectedLabel?: string
    expectedNamespaces?: string[]
    matchedTools?: string[]
}

/** Maximum score allowed when the agent simulated tool use instead of calling one. */
export const SIDE_EFFECT_PENALTY_CEILING = 0.25

/**
 * Pure inspection — compares the user's request, the agent's deliverable
 * summary, and the list of tools it actually invoked. Returns a penalty
 * decision with a human-readable reason when the agent simulated tool use
 * instead of actually calling a matching tool.
 */
export function detectSideEffectGap(
    userRequest: string,
    deliverableSummary: string,
    toolsUsed: string[],
): SideEffectCheck {
    if (!userRequest || !userRequest.trim()) return { penalised: false }
    const tools = toolsUsed.map((t) => t.toLowerCase())

    for (const hint of ACTION_TOOL_HINTS) {
        if (!hint.pattern.test(userRequest)) continue
        const matchedTools = tools.filter((t) =>
            hint.expectedNamespaces.some((ns) => t.includes(ns.toLowerCase())),
        )
        if (matchedTools.length === 0) {
            const hypotheticalHit = HYPOTHETICAL_PATTERNS.some((p) => p.test(deliverableSummary))
            const reason = hypotheticalHit
                ? `User asked for ${hint.label} action but agent described it without calling any ${hint.expectedNamespaces.join(' / ')} tool.`
                : `User asked for ${hint.label} action but no ${hint.expectedNamespaces.join(' / ')} tool was invoked.`
            return {
                penalised: true,
                reason,
                expectedLabel: hint.label,
                expectedNamespaces: hint.expectedNamespaces,
                matchedTools: [],
            }
        }
        return { penalised: false, expectedLabel: hint.label, matchedTools }
    }
    return { penalised: false }
}
