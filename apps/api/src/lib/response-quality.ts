// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

// Response quality checker — detects and strips model artifacts before delivery.
// Emits plexo_ops_errors when issues are detected so CC can track and fix.

// Patterns that should never appear in user-facing responses
const TOOL_CALL_PATTERNS = [
    /<call\s+type="tool"[^>]*>[\s\S]*?<\/call>/gi,
    /<function_call>[\s\S]*?<\/function_call>/gi,
    /<tool_call>[\s\S]*?<\/tool_call>/gi,
    /<\|tool_call\|>[\s\S]*?<\|\/tool_call\|>/gi,
    /<thinking>[\s\S]*?<\/thinking>/gi,
    /<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi,
]

export function stripModelArtifacts(text: string): { cleaned: string; stripped: string[] } {
    const stripped: string[] = []
    let cleaned = text
    for (const pattern of TOOL_CALL_PATTERNS) {
        const matches = cleaned.match(pattern)
        if (matches) {
            stripped.push(...matches.map(m => m.slice(0, 100)))
            cleaned = cleaned.replace(pattern, '').trim()
        }
    }
    return { cleaned, stripped }
}

export function checkResponseQuality(text: string, workspaceId: string): { text: string; issues: string[] } {
    const issues: string[] = []
    const { cleaned, stripped } = stripModelArtifacts(text)

    if (stripped.length > 0) {
        issues.push(`Leaked model artifacts: ${stripped.length} patterns stripped`)
    }
    if (cleaned.length === 0 && text.length > 0) {
        issues.push('Response became empty after stripping artifacts')
    }
    if (cleaned.length > 0 && cleaned.length < 10 && !cleaned.match(/^(ok|yes|no|done|sure|thanks)$/i)) {
        issues.push(`Suspiciously short response: "${cleaned}"`)
    }

    // Emit to plexo_ops_errors if issues found
    if (issues.length > 0) {
        emitQualityError(workspaceId, issues, text.slice(0, 500))
    }

    return { text: cleaned || text, issues }
}

function emitQualityError(workspaceId: string, issues: string[], rawSample: string): void {
    try {
        const { trackError } = require('../event-tracker')
        trackError(new Error(`Response quality: ${issues.join('; ')}`), {
            workspaceId,
            category: 'response_quality',
            issues,
            rawSample: rawSample.slice(0, 200),
        })
    } catch { /* non-fatal */ }
}
