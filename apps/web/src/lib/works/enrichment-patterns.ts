// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 — text enrichment tokenizer.
//
// Pure logic (no JSX) that splits a text string into a sequence of
// "segments" — plain text, internal-path, external-url, api-key-link,
// action-button, tool-mention. The `InstructionsRenderer` consumes
// these segments and renders each as the appropriate component.
//
// Rules:
// - Order of enrichers matters. Action > internal path > api key URL >
//   generic URL > tool mention. First match in any position wins.
// - Segments never overlap. Once a span is claimed, later enrichers
//   only scan the remaining plain-text regions.
// - Unmatched text is emitted as `text` segments, preserving order.
// - External URL sanitization: only http/https pass through; any
//   `javascript:` / `data:` / other schemes are treated as plain text.

import { findPlexoAction, type PlexoActionEntry } from './plexo-actions'
import { findPlexoPath } from './plexo-paths'
import { matchProviderByUrl, type ApiKeyProvider } from './api-key-providers'

export type EnrichedSegment =
    | { kind: 'text', value: string }
    | { kind: 'internal-link', href: string, label: string, raw: string }
    | { kind: 'external-link', href: string, raw: string }
    | { kind: 'api-key-link', provider: ApiKeyProvider, raw: string }
    | { kind: 'action', entry: PlexoActionEntry, match: RegExpMatchArray, raw: string }
    | { kind: 'tool-mention', toolName: string, raw: string }

// Bare URL pattern. Accepts http(s). Does not include trailing
// punctuation. Keeps query strings and paths.
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`\]]+[^\s<>()"'`\].,;!?]/i

// Tool mention: tool names follow the `namespace__function` convention
// used by MCP/Plexo tools (e.g. `notion__create_page`, `fs__read`).
const TOOL_RE = /\b([a-z][a-z0-9_]{1,32}__[a-z][a-z0-9_]{1,48})\b/i

export function sanitizeExternalUrl(url: string): string | null {
    try {
        const parsed = new URL(url)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.toString()
        }
        return null
    } catch {
        return null
    }
}

interface Match {
    start: number
    end: number
    segment: EnrichedSegment
}

/**
 * Scan a plain-text string for enrichment matches. Returns an ordered
 * array of segments where the non-text ones cover pieces of the
 * original string and the text ones are the untouched gaps.
 */
export function enrichText(input: string): EnrichedSegment[] {
    if (!input) return []

    const matches: Match[] = []

    // 1. Plexo actions — highest precedence so "install X connection"
    //    beats a generic word match.
    collectAction(input, matches)

    // 2. Plexo internal paths / page references.
    collectInternalPath(input, matches)

    // 3. API key provider URLs first (more specific than generic URL).
    collectApiKeyUrl(input, matches)

    // 4. Generic external URLs in the leftover text.
    collectExternalUrl(input, matches)

    // 5. Tool mentions.
    collectToolMention(input, matches)

    if (matches.length === 0) {
        return [{ kind: 'text', value: input }]
    }

    // Sort + drop overlaps (first wins, which in order means
    // action > path > api-key > url > tool).
    matches.sort((a, b) => a.start - b.start)
    const dedup: Match[] = []
    let cursor = 0
    for (const m of matches) {
        if (m.start < cursor) continue
        dedup.push(m)
        cursor = m.end
    }

    const out: EnrichedSegment[] = []
    let i = 0
    for (const m of dedup) {
        if (m.start > i) out.push({ kind: 'text', value: input.slice(i, m.start) })
        out.push(m.segment)
        i = m.end
    }
    if (i < input.length) out.push({ kind: 'text', value: input.slice(i) })
    return out
}

function collectAction(input: string, matches: Match[]): void {
    // Find all matches of each action entry by walking with a
    // globalised copy of the regex.
    for (const found of findAllPlexoActions(input)) {
        matches.push({
            start: found.index,
            end: found.index + found.raw.length,
            segment: { kind: 'action', entry: found.entry, match: found.match, raw: found.raw },
        })
    }
}

function findAllPlexoActions(input: string): Array<{ index: number, raw: string, entry: PlexoActionEntry, match: RegExpMatchArray }> {
    const out: Array<{ index: number, raw: string, entry: PlexoActionEntry, match: RegExpMatchArray }> = []
    // Walk the string in slices to find each non-overlapping action match.
    let rest = input
    let offset = 0
    while (rest.length > 0) {
        const found = findPlexoAction(rest)
        if (!found) break
        const idx = found.match.index ?? 0
        const raw = found.match[0]
        out.push({ index: offset + idx, raw, entry: found.entry, match: found.match })
        const advance = idx + raw.length
        rest = rest.slice(advance)
        offset += advance
    }
    return out
}

function collectInternalPath(input: string, matches: Match[]): void {
    let rest = input
    let offset = 0
    while (rest.length > 0) {
        const found = findPlexoPath(rest)
        if (!found) break
        const idx = found.match.index ?? 0
        const raw = found.match[0]
        matches.push({
            start: offset + idx,
            end: offset + idx + raw.length,
            segment: { kind: 'internal-link', href: found.entry.href, label: found.entry.label, raw },
        })
        const advance = idx + raw.length
        rest = rest.slice(advance)
        offset += advance
    }
}

function collectApiKeyUrl(input: string, matches: Match[]): void {
    // Walk to find each URL; if the URL's domain matches a provider,
    // emit as api-key-link rather than a plain external url.
    const re = new RegExp(URL_RE.source, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(input)) !== null) {
        const rawUrl = m[0]
        const sanitized = sanitizeExternalUrl(rawUrl)
        if (!sanitized) continue
        const provider = matchProviderByUrl(sanitized)
        if (!provider) continue
        matches.push({
            start: m.index,
            end: m.index + rawUrl.length,
            segment: { kind: 'api-key-link', provider, raw: rawUrl },
        })
    }
}

function collectExternalUrl(input: string, matches: Match[]): void {
    const re = new RegExp(URL_RE.source, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(input)) !== null) {
        const rawUrl = m[0]
        const sanitized = sanitizeExternalUrl(rawUrl)
        if (!sanitized) continue
        matches.push({
            start: m.index,
            end: m.index + rawUrl.length,
            segment: { kind: 'external-link', href: sanitized, raw: rawUrl },
        })
    }
}

function collectToolMention(input: string, matches: Match[]): void {
    const re = new RegExp(TOOL_RE.source, 'gi')
    let m: RegExpExecArray | null
    while ((m = re.exec(input)) !== null) {
        matches.push({
            start: m.index,
            end: m.index + m[0].length,
            segment: { kind: 'tool-mention', toolName: m[0], raw: m[0] },
        })
    }
}
