// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PII Scrubbing Pipeline
 *
 * Removes personally identifiable information from text while preserving
 * structural patterns for model training. Regex-based for v1 — no
 * external NLP dependencies.
 *
 * Replaces: emails, phones, SSNs, addresses, financial amounts,
 * dates of birth, URLs with auth tokens, and capitalized name sequences.
 */

// ── Pattern definitions ──────────────────────────────────────────────────────

const PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
    // Email addresses
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL]' },

    // Phone numbers (international and US formats)
    { pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}\b/g, replacement: '[PHONE]' },

    // SSN / National IDs
    { pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g, replacement: '[ID]' },
    { pattern: /\b[A-Z]{1,2}\d{6,9}\b/g, replacement: '[ID]' },

    // Credit card numbers (basic patterns)
    { pattern: /\b(?:\d{4}[-.\s]?){3}\d{4}\b/g, replacement: '[CARD]' },

    // Financial amounts ($1,234.56 or £1234 or €1.234,56)
    { pattern: /[$£€¥]\s*\d{1,3}(?:[,.\s]\d{3})*(?:[.,]\d{2})?\b/g, replacement: '[AMOUNT]' },
    { pattern: /\b\d{1,3}(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|EUR|GBP|JPY|CAD|AUD)\b/gi, replacement: '[AMOUNT]' },

    // Dates of birth (various formats)
    { pattern: /\b(?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])[-/.](?:19|20)\d{2}\b/g, replacement: '[DOB]' },
    { pattern: /\b(?:19|20)\d{2}[-/.](?:0?[1-9]|1[0-2])[-/.](?:0?[1-9]|[12]\d|3[01])\b/g, replacement: '[DOB]' },
    { pattern: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi, replacement: '[DOB]' },

    // Street addresses (basic: number + street name)
    { pattern: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Place|Pl|Circle|Cir)\b\.?/gi, replacement: '[ADDRESS]' },

    // ZIP/postal codes (US)
    { pattern: /\b\d{5}(?:-\d{4})?\b/g, replacement: '[ZIP]' },

    // URLs with tokens/keys
    { pattern: /https?:\/\/[^\s]+(?:token|key|secret|auth|password|apikey)=[^\s&]+/gi, replacement: '[URL_WITH_AUTH]' },

    // API keys (common patterns)
    { pattern: /\b(?:sk|pk|api|key|token)[-_][A-Za-z0-9]{20,}\b/g, replacement: '[API_KEY]' },

    // Named entities: capitalized multi-word sequences (2-4 words) likely names
    // Run LAST to avoid clobbering other replacements
    { pattern: /\b(?:[A-Z][a-z]+\s+){1,3}[A-Z][a-z]+\b/g, replacement: '[PERSON]' },
]

// ── Scrubbing function ───────────────────────────────────────────────────────

/**
 * Scrub PII from text, preserving structural task patterns.
 *
 * Returns the scrubbed text. Original text is never stored.
 */
export function scrubPII(text: string): string {
    let result = text

    for (const { pattern, replacement } of PATTERNS) {
        // Reset regex state (global flag)
        pattern.lastIndex = 0
        result = result.replace(pattern, replacement)
    }

    // Collapse consecutive identical replacements
    result = result.replace(/(\[(?:PERSON|EMAIL|PHONE|ID|AMOUNT|ADDRESS)\])(?:\s*\1)+/g, '$1')

    return result
}

/**
 * Check if text likely contains PII (for early exit optimization).
 */
export function likelyContainsPII(text: string): boolean {
    // Quick checks before running full pipeline
    return /[@]|(?:\d{3}[-.]?\d{3,4})|(?:\$|£|€)\d|(?:[A-Z][a-z]+\s+[A-Z][a-z]+)/.test(text)
}
