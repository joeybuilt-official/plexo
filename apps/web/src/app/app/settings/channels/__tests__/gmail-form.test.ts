// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase L3 Stage 2 — Gmail channel form helper tests.
 *
 * apps/web tests run under a node environment (no DOM), so these exercise the
 * pure helpers behind the GmailForm component:
 *   - email extraction from an installed-connection record
 *   - channel-create config shape (the body submitted to POST /channels)
 *   - OAuth-start URL construction (relative, same-origin)
 */

import { describe, it, expect } from 'vitest'

import {
    gmailEmailFromConnection,
    buildGmailChannelConfig,
    buildGmailOauthStartUrl,
} from '../page'

describe('gmailEmailFromConnection', () => {
    it('returns the label when it looks like an email', () => {
        expect(gmailEmailFromConnection({ label: 'alice@example.com', name: 'Gmail' })).toBe('alice@example.com')
    })

    it('falls back to name when label is the placeholder "default"', () => {
        expect(gmailEmailFromConnection({ label: 'default', name: 'bob@example.com' })).toBe('bob@example.com')
    })

    it('returns empty string when neither field is an email', () => {
        expect(gmailEmailFromConnection({ label: 'default', name: 'My Gmail' })).toBe('')
    })

    it('returns empty string for undefined', () => {
        expect(gmailEmailFromConnection(undefined)).toBe('')
    })
})

describe('buildGmailChannelConfig', () => {
    it('returns null when no connection id is selected (caller blocks submit)', () => {
        expect(buildGmailChannelConfig(null, undefined)).toBeNull()
        expect(buildGmailChannelConfig('', undefined)).toBeNull()
    })

    it('builds the config payload with installedConnectionId + emailAddress', () => {
        const cfg = buildGmailChannelConfig('conn-123', { label: 'alice@example.com', name: 'Gmail' })
        expect(cfg).toEqual({
            installedConnectionId: 'conn-123',
            emailAddress: 'alice@example.com',
        })
    })

    it('emits empty emailAddress rather than throwing when connection lookup misses', () => {
        const cfg = buildGmailChannelConfig('conn-456', undefined)
        expect(cfg).toEqual({
            installedConnectionId: 'conn-456',
            emailAddress: '',
        })
    })
})

describe('buildGmailOauthStartUrl', () => {
    it('builds a relative same-origin URL when API_BASE is empty (browser default)', () => {
        const url = buildGmailOauthStartUrl('ws-uuid-1', '')
        expect(url).toBe('/api/v1/oauth/gmail/start?workspaceId=ws-uuid-1')
    })

    it('encodes the workspaceId query param', () => {
        const url = buildGmailOauthStartUrl('a b/c', '')
        expect(url).toBe('/api/v1/oauth/gmail/start?workspaceId=a%20b%2Fc')
    })

    it('respects an absolute API base for SSR contexts', () => {
        const url = buildGmailOauthStartUrl('ws-7', 'http://localhost:3001')
        expect(url).toBe('http://localhost:3001/api/v1/oauth/gmail/start?workspaceId=ws-7')
    })
})

describe('Gmail dropdown population (data filter)', () => {
    // Mirrors the inline filter used by GmailForm to pick gmail rows
    // out of the installedConnections list.
    const installed = [
        { id: 'a', registryId: 'gmail', name: 'Gmail', label: 'alice@example.com', status: 'active' },
        { id: 'b', registryId: 'github', name: 'GitHub', label: 'default', status: 'active' },
        { id: 'c', registryId: 'gmail', name: 'Gmail', label: 'team@example.com', status: 'active' },
    ]

    it('keeps only registryId === "gmail" rows', () => {
        const gmailRows = installed.filter((c) => c.registryId === 'gmail')
        expect(gmailRows.map((r) => r.id)).toEqual(['a', 'c'])
    })

    it('renders a label and email pair for each option (the form maps these to <option>)', () => {
        const gmailRows = installed.filter((c) => c.registryId === 'gmail')
        const options = gmailRows.map((c) => ({
            id: c.id,
            display: `${c.label}${gmailEmailFromConnection(c) ? ` (${gmailEmailFromConnection(c)})` : ''}`,
        }))
        expect(options).toEqual([
            { id: 'a', display: 'alice@example.com (alice@example.com)' },
            { id: 'c', display: 'team@example.com (team@example.com)' },
        ])
    })

    it('empty-connections branch fires when no gmail rows are present', () => {
        const noGmail = installed.filter((c) => c.registryId === 'github')
        const showInstallOnly = noGmail.filter((c) => c.registryId === 'gmail').length === 0
        expect(showInstallOnly).toBe(true)
    })
})
