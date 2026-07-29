// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 — unit tests for the link-enrichment tokenizer.
//
// Pure-logic tests only. JSX rendering is covered by manual review and
// a fixture page; the node-env vitest surface does not execute DOM.

import { describe, it, expect } from 'vitest'

import {
    enrichText,
    sanitizeExternalUrl,
} from '../../../lib/works/enrichment-patterns'
import { findPlexoPath } from '../../../lib/works/plexo-paths'
import { findPlexoAction } from '../../../lib/works/plexo-actions'
import { matchProviderByUrl, matchProviderByName } from '../../../lib/works/api-key-providers'

describe('sanitizeExternalUrl', () => {
    it('passes https URLs through', () => {
        expect(sanitizeExternalUrl('https://example.com/path?q=1')).toContain('https://example.com')
    })
    it('passes http URLs through', () => {
        expect(sanitizeExternalUrl('http://example.com')).toContain('http://example.com')
    })
    it('rejects javascript: URLs', () => {
        expect(sanitizeExternalUrl('javascript:alert(1)')).toBeNull()
    })
    it('rejects data: URLs', () => {
        expect(sanitizeExternalUrl('data:text/html,foo')).toBeNull()
    })
    it('rejects garbage', () => {
        expect(sanitizeExternalUrl('not a url')).toBeNull()
    })
})

describe('findPlexoPath', () => {
    it('matches "Settings > AI Models"', () => {
        const found = findPlexoPath('Go to Settings > AI Models to configure.')
        expect(found?.entry.href).toBe('/app/settings/ai-models')
    })
    it('matches "Settings → AI Models" with arrow', () => {
        const found = findPlexoPath('Open Settings → AI Models.')
        expect(found?.entry.href).toBe('/app/settings/ai-models')
    })
    it('matches "the Tasks page"', () => {
        const found = findPlexoPath('Open the Tasks page.')
        expect(found?.entry.href).toBe('/app/tasks')
    })
    it('matches raw /app/memory', () => {
        const found = findPlexoPath('See /app/memory for details.')
        expect(found?.entry.href).toBe('/app/memory')
    })
    it('returns null for plain prose', () => {
        expect(findPlexoPath('This is just some text.')).toBeNull()
    })
    it('prefers deep Settings path over generic Settings', () => {
        const found = findPlexoPath('Open Settings > Channels now.')
        expect(found?.entry.href).toBe('/app/settings/channels')
    })
})

describe('findPlexoAction', () => {
    it('matches "install the Notion connection"', () => {
        const found = findPlexoAction('install the Notion connection')
        expect(found?.entry.action(found.match)).toEqual({ type: 'install', kind: 'connection', id: 'notion' })
    })
    it('matches "Add a Slack connection"', () => {
        const found = findPlexoAction('Add a Slack connection')
        expect(found?.entry.action(found.match)).toEqual({ type: 'install', kind: 'connection', id: 'slack' })
    })
    it('matches "enable the deep-research tool"', () => {
        const found = findPlexoAction('enable the deep-research tool')
        expect(found?.entry.action(found.match)).toEqual({ type: 'install', kind: 'tool', id: 'deep-research' })
    })
    it('returns null for prose', () => {
        expect(findPlexoAction('Just plain text.')).toBeNull()
    })
})

describe('api key provider registry', () => {
    it('matches OpenAI by domain', () => {
        expect(matchProviderByUrl('https://platform.openai.com/api-keys')?.id).toBe('openai')
    })
    it('matches Anthropic by domain', () => {
        expect(matchProviderByUrl('https://console.anthropic.com/keys')?.id).toBe('anthropic')
    })
    it('matches Notion integrations', () => {
        expect(matchProviderByUrl('https://www.notion.so/my-integrations')?.id).toBe('notion')
    })
    it('returns null for unknown domain', () => {
        expect(matchProviderByUrl('https://example.com')).toBeNull()
    })
    it('matches Notion by name', () => {
        expect(matchProviderByName('You will need Notion for this step.')?.id).toBe('notion')
    })
})

describe('enrichText', () => {
    it('returns a single text segment when nothing matches', () => {
        const out = enrichText('Hello world, nothing to enrich here.')
        expect(out).toHaveLength(1)
        expect(out[0]).toMatchObject({ kind: 'text' })
    })

    it('detects a bare external URL', () => {
        const out = enrichText('Visit https://example.com for more info.')
        const ext = out.find(s => s.kind === 'external-link')
        expect(ext).toBeDefined()
        if (ext && ext.kind === 'external-link') {
            expect(ext.href).toContain('https://example.com')
        }
    })

    it('detects an API-key provider URL as api-key-link', () => {
        const out = enrichText('Get an API key at https://platform.openai.com/api-keys')
        const apikey = out.find(s => s.kind === 'api-key-link')
        expect(apikey).toBeDefined()
        if (apikey && apikey.kind === 'api-key-link') {
            expect(apikey.provider.id).toBe('openai')
        }
    })

    it('detects an internal path reference', () => {
        const out = enrichText('Open Settings > AI Models and add your key.')
        const internal = out.find(s => s.kind === 'internal-link')
        expect(internal).toBeDefined()
        if (internal && internal.kind === 'internal-link') {
            expect(internal.href).toBe('/app/settings/ai-models')
        }
    })

    it('detects an install-connection action button', () => {
        const out = enrichText('Then install the Notion connection.')
        const action = out.find(s => s.kind === 'action')
        expect(action).toBeDefined()
        if (action && action.kind === 'action') {
            expect(action.entry.action(action.match)).toEqual({ type: 'install', kind: 'connection', id: 'notion' })
        }
    })

    it('detects a tool mention', () => {
        const out = enrichText('Then run the notion__list_databases tool.')
        const tool = out.find(s => s.kind === 'tool-mention')
        expect(tool).toBeDefined()
        if (tool && tool.kind === 'tool-mention') {
            expect(tool.toolName).toBe('notion__list_databases')
        }
    })

    it('handles a mixed sentence with many segments', () => {
        const input = 'Get a key at https://platform.openai.com/api-keys then go to Settings > AI Models and install the OpenAI connection.'
        const out = enrichText(input)
        const kinds = out.map(s => s.kind)
        expect(kinds).toContain('api-key-link')
        expect(kinds).toContain('internal-link')
        expect(kinds).toContain('action')
    })

    it('does not double-claim overlapping matches', () => {
        // "Settings > AI Models" and a bare URL in the same line; both
        // must appear exactly once.
        const input = 'See https://example.com/foo and then Settings > AI Models.'
        const out = enrichText(input)
        expect(out.filter(s => s.kind === 'external-link')).toHaveLength(1)
        expect(out.filter(s => s.kind === 'internal-link')).toHaveLength(1)
    })

    it('ignores javascript: URLs even if present', () => {
        const input = 'Evil: javascript:alert(1) should not become a link.'
        const out = enrichText(input)
        expect(out.filter(s => s.kind === 'external-link')).toHaveLength(0)
    })

    it('preserves the untouched text around each match', () => {
        const out = enrichText('Before https://example.com after')
        const texts = out.filter(s => s.kind === 'text').map(s => (s as { value: string }).value)
        expect(texts.join('|')).toContain('Before')
        expect(texts.join('|')).toContain('after')
    })

    it('returns empty array for empty input', () => {
        expect(enrichText('')).toEqual([])
    })
})
