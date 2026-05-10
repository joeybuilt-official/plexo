// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 7 — Audit logger unit tests.
 *
 * Covers the pure helpers: tool key parsing and extension identity resolution.
 * DB writes are not exercised here — the logger is fire-and-forget and the
 * runtime smoke covers the insert path.
 */
import { describe, it, expect } from 'vitest'
import { parseToolKey } from './audit-keys.js'

describe('parseToolKey', () => {
    it('round-trips a scoped extension key', () => {
        // bridge.ts :: toolKey('@plexo/research-agent', 'research_query')
        //   -> 'plugin__plexo_research-agent__research_query'
        const parsed = parseToolKey('plugin__plexo_research-agent__research_query')
        expect(parsed).toEqual({
            extensionName: '@plexo/research-agent',
            toolName: 'research_query',
        })
    })

    it('parses unscoped extension names', () => {
        // An extension without an @scope still produces a deterministic key.
        const parsed = parseToolKey('plugin__standalone__do_thing')
        expect(parsed).toEqual({
            extensionName: 'standalone',
            toolName: 'do_thing',
        })
    })

    it('returns null for system tools', () => {
        expect(parseToolKey('task_complete')).toBeNull()
        expect(parseToolKey('read_file')).toBeNull()
        expect(parseToolKey('some_random_tool')).toBeNull()
    })

    it('returns null for malformed plugin keys', () => {
        expect(parseToolKey('plugin__onlyonepart')).toBeNull()
        expect(parseToolKey('plugin__')).toBeNull()
    })

    it('preserves underscores in tool names', () => {
        const parsed = parseToolKey('plugin__plexo_research-agent__fetch_and_summarize_url')
        expect(parsed).toEqual({
            extensionName: '@plexo/research-agent',
            toolName: 'fetch_and_summarize_url',
        })
    })
})
