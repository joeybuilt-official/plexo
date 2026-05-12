// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure detection functions for conversation instruction signals.
 * No external dependencies — safe for testing.
 */

/**
 * Patterns that signal the user is giving an explicit behavioral instruction.
 */
const INSTRUCTION_PATTERNS = [
    /\b(always|never|don'?t|stop|start|keep|from now on)\b.{0,60}\b(respond|reply|answer|talk|write|speak|communicate|say)\b/i,
    /\b(i want|i need|i('d)? like)\s+you\s+to\b/i,
    /\bwhen\s+(i|we)\s+(ask|say|tell|request|mention)\b/i,
    /\b(be more|be less|tone|shorter|longer|concise|brief|verbose|detailed)\b/i,
    /\buntil\s+(i\s+(tell|say|ask)|further\s+notice)\b/i,
    /\b(remember\s+that|keep\s+in\s+mind|note\s+that|don'?t\s+forget)\b/i,
    /\b(call\s+me|my\s+name\s+is|i('?m| am)\s+(a|an|the)\s+\w+)\b/i,
]

const REVOCATION_PATTERNS = [
    /\buntil\s+i\s+(tell|say|ask)\s+(you\s+)?(to\s+)?stop\b/i,
    /\buntil\s+further\s+notice\b/i,
    /\buntil\s+i\s+(change|update|modify)\b/i,
    /\bfor\s+now\b/i,
    /\bjust\s+for\s+(this|today|tonight|the\s+moment)\b/i,
]

const SAFETY_PATTERNS = [
    /\b(ignore|disregard|forget|override)\s+(all|previous|prior|your|system|safety)\b/i,
    /\b(remove|delete|disable)\s+(all|your|the)\s+(rules|constraints|limits|safety)\b/i,
]

export function hasInstructionIntent(message: string): boolean {
    return INSTRUCTION_PATTERNS.some(p => p.test(message))
}

export function hasRevocationCondition(message: string): boolean {
    return REVOCATION_PATTERNS.some(p => p.test(message))
}

export function isSafetyBypass(message: string): boolean {
    return SAFETY_PATTERNS.some(p => p.test(message))
}

export function extractRevocationTrigger(message: string): string {
    for (const pattern of REVOCATION_PATTERNS) {
        const match = message.match(pattern)
        if (match) return match[0]
    }
    return 'until told to stop'
}
