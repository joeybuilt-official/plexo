// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export interface ErrorPresentation {
    what: string
    why: string
    action: string
    code: string
}

const ERROR_MATCHERS: Array<{ pattern: RegExp; presentation: ErrorPresentation }> = [
    {
        pattern: /TOOL_TIMEOUT/i,
        presentation: {
            what: 'A tool stopped responding and the 90-second timeout was reached.',
            why: 'The external tool or API the agent called hung or took too long to return.',
            action: 'Retry the task. If it keeps timing out, check the tool or service for outages.',
            code: 'TOOL_TIMEOUT',
        },
    },
    {
        pattern: /fallback|all providers/i,
        presentation: {
            what: 'All LLM providers in the routing chain failed.',
            why: 'Every configured provider returned an error, likely due to rate limits or outages.',
            action: 'Check your AI provider API keys and quota in Settings, then retry.',
            code: 'ROUTING_EXHAUSTED',
        },
    },
    {
        pattern: /max.*step|step.*iteration/i,
        presentation: {
            what: 'The agent hit its maximum step limit without completing the task.',
            why: 'The task was too complex or the agent got stuck in a loop.',
            action: 'Break the task into smaller pieces and retry, or increase the step limit if appropriate.',
            code: 'MAX_STEPS',
        },
    },
    {
        pattern: /ESCALATION_TIMED_OUT|escalation.*timed?\s*out/i,
        presentation: {
            what: 'An approval request timed out waiting for a response.',
            why: 'The agent needed human approval for a sensitive operation, but nobody responded in time.',
            action: 'Retry the task and approve the escalation prompt when it appears.',
            code: 'ESCALATION_TIMED_OUT',
        },
    },
    {
        pattern: /WORKER_CRASH/i,
        presentation: {
            what: 'The worker thread crashed while processing this task.',
            why: 'An unexpected internal error caused the worker process to terminate.',
            action: 'Retry the task. If it crashes again, report the issue.',
            code: 'WORKER_CRASH',
        },
    },
    {
        pattern: /DB_WRITE_FAILED|database/i,
        presentation: {
            what: 'A database write failed while saving task results.',
            why: 'The database may be temporarily unavailable or a constraint was violated.',
            action: 'Retry the task. If it persists, check database connectivity and disk space.',
            code: 'DB_WRITE_FAILED',
        },
    },
    {
        pattern: /\babort|cancelled/i,
        presentation: {
            what: 'This task was cancelled before it could finish.',
            why: 'A user or system process cancelled the task.',
            action: 'Re-submit the task if you still need it completed.',
            code: 'CANCELLED',
        },
    },
]

export function presentError(outcomeSummary: string): ErrorPresentation | null {
    for (const { pattern, presentation } of ERROR_MATCHERS) {
        if (pattern.test(outcomeSummary)) return presentation
    }
    return null
}
