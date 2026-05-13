// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 unit tests — dispatch logic + client-side kind inference.
// Pure-logic tests only; rendering is not exercised here because the
// apps/web test surface runs under a node environment (no DOM). The
// important contract is: given a Work shape, we route it to the correct
// renderer component.

import { describe, it, expect } from 'vitest'

import { resolveKindFromWork, inferKindClient } from '../infer-kind-client'
import type { WorkKind } from '../infer-kind-client'

// Local mirror of the Work shape we need for dispatch tests. Avoids
// pulling in `@web/app/...` aliases that the repo-root vitest config
// does not declare.
interface Work {
    filename: string
    bytes: number
    isText: boolean
    content: string | null
    kind?: WorkKind
    meta?: Record<string, unknown>
}

const resolveKind = resolveKindFromWork

function work(partial: Partial<Work> & { filename: string }): Work {
    return {
        filename: partial.filename,
        bytes: partial.content?.length ?? 0,
        isText: true,
        content: partial.content ?? null,
        kind: partial.kind,
        meta: partial.meta,
    }
}

describe('inferKindClient', () => {
    it('maps markdown extensions to markdown', () => {
        expect(inferKindClient('notes.md').kind).toBe('markdown')
        expect(inferKindClient('notes.markdown').kind).toBe('markdown')
        expect(inferKindClient('notes.mdx').kind).toBe('markdown')
    })

    it('maps code extensions with a language hint', () => {
        expect(inferKindClient('app.ts')).toEqual({ kind: 'code', language: 'typescript' })
        expect(inferKindClient('main.py')).toEqual({ kind: 'code', language: 'python' })
        expect(inferKindClient('script.sh')).toEqual({ kind: 'code', language: 'bash' })
    })

    it('maps html / csv / json / svg correctly', () => {
        expect(inferKindClient('page.html').kind).toBe('html')
        expect(inferKindClient('data.csv').kind).toBe('table')
        expect(inferKindClient('config.json').kind).toBe('json')
        expect(inferKindClient('logo.svg').kind).toBe('image')
    })

    it('maps Dockerfile bare-name to config', () => {
        expect(inferKindClient('Dockerfile').kind).toBe('config')
        expect(inferKindClient('Makefile').kind).toBe('code')
    })

    it('promotes markdown with 3+ numbered steps to instructions', () => {
        const body = '1. Open the file\n2. Edit line 5\n3. Save'
        expect(inferKindClient('readme.md', body).kind).toBe('instructions')
    })

    it('promotes markdown with mostly-links to link-list', () => {
        const body = '- [One](https://a.com)\n- [Two](https://b.com)\n- [Three](https://c.com)'
        expect(inferKindClient('links.md', body).kind).toBe('link-list')
    })

    it('falls back to markdown for unknown text-ish ext with content', () => {
        expect(inferKindClient('weird.xyz', 'hello world').kind).toBe('markdown')
    })

    it('falls back to file for unknown ext without content', () => {
        expect(inferKindClient('weird.xyz').kind).toBe('file')
    })
})

describe('resolveKind', () => {
    it('prefers explicit work.kind over inference', () => {
        const w = work({ filename: 'thing.md', content: 'plain', kind: 'checklist' })
        expect(resolveKind(w)).toBe('checklist')
    })

    it('falls back to inference when kind is absent', () => {
        const w = work({ filename: 'style.css', content: '.a{}' })
        expect(resolveKind(w)).toBe('markdown') // unknown ext, has text content
    })

    it('routes html filename to html kind (not mockup) by default', () => {
        const w = work({ filename: 'page.html', content: '<p>hi</p>' })
        expect(resolveKind(w)).toBe('html')
    })

    it('honours kind=mockup override for html content', () => {
        const w = work({ filename: 'landing.html', content: '<p>hi</p>', kind: 'mockup' })
        expect(resolveKind(w)).toBe('mockup')
    })

    it('returns file for totally opaque work', () => {
        const w = work({ filename: 'blob.bin', content: null })
        expect(resolveKind(w)).toBe('file')
    })
})
