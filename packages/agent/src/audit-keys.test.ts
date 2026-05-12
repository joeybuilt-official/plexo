// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * parseToolKey unit tests.
 *
 * Pins:
 *   1. System (non-plugin) tool keys → null
 *   2. Scoped plugin key → correct extensionName + toolName
 *   3. plugin__ prefix with no __ separator → null
 *   4. plugin__ with empty scope segment → null
 *   5. plugin__ with empty toolName segment → null
 *   6. Single-segment scope (no org slash) → extensionName without @ prefix
 *   7. Tool name containing underscores → preserved as-is
 *   8. Empty string → null
 */

import { describe, it, expect } from 'vitest'
import { parseToolKey } from './audit-keys.js'

describe('parseToolKey', () => {
    it('returns null for system tool keys that do not start with plugin__', () => {
        expect(parseToolKey('task_complete')).toBeNull()
        expect(parseToolKey('read_file')).toBeNull()
        expect(parseToolKey('list_my_tools')).toBeNull()
        expect(parseToolKey('get_my_capabilities')).toBeNull()
    })

    it('returns null for empty string', () => {
        expect(parseToolKey('')).toBeNull()
    })

    it('returns extensionName and toolName for a valid scoped plugin key', () => {
        // toolKey('plugin__joeybuilt_github__create_pr') from '@joeybuilt/github'
        const result = parseToolKey('plugin__joeybuilt_github__create_pr')
        expect(result).not.toBeNull()
        expect(result!.extensionName).toBe('@joeybuilt/github')
        expect(result!.toolName).toBe('create_pr')
    })

    it('handles a second scoped plugin key with a different org/package', () => {
        // '@plexo/devops' → scope sanitized to 'plexo_devops'
        const result = parseToolKey('plugin__plexo_devops__run_command')
        expect(result).not.toBeNull()
        expect(result!.extensionName).toBe('@plexo/devops')
        expect(result!.toolName).toBe('run_command')
    })

    it('returns null when there is no __ separator after plugin__', () => {
        expect(parseToolKey('plugin__nodoublesep')).toBeNull()
    })

    it('returns null when the scope segment is empty', () => {
        // plugin_____toolName → scope is empty after slice
        expect(parseToolKey('plugin_____toolName')).toBeNull()
    })

    it('returns null when the toolName segment is empty', () => {
        expect(parseToolKey('plugin__myscope__')).toBeNull()
    })

    it('handles a single-segment scope (no org — no underscore to reverse)', () => {
        // scope 'singlescope' has no underscore → extensionName is just 'singlescope' (no @)
        const result = parseToolKey('plugin__singlescope__do_thing')
        expect(result).not.toBeNull()
        // firstUnderscore < 0 so no @ prefix reversal
        expect(result!.extensionName).toBe('singlescope')
        expect(result!.toolName).toBe('do_thing')
    })

    it('preserves underscores within the tool name', () => {
        const result = parseToolKey('plugin__my_org__send_slack_message')
        expect(result).not.toBeNull()
        expect(result!.extensionName).toBe('@my/org')
        expect(result!.toolName).toBe('send_slack_message')
    })
})
