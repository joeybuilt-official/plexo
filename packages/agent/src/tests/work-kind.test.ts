// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 — Works taxonomy: inferKind + kindToLegacyType + WORK_KINDS.

import { describe, test, expect } from 'vitest'

// Import directly from the pure work-kind subpath to avoid pulling in the
// @plexo/db barrel (which touches the postgres client). The subpath is
// declared in packages/db/package.json exports.
import { inferKind, kindToLegacyType, WORK_KINDS, type WorkKind } from '@plexo/db/work-kind'

describe('WORK_KINDS constant', () => {
    test('contains the full Phase 2 taxonomy', () => {
        const expected: WorkKind[] = [
            'markdown', 'instructions', 'code', 'html', 'mockup',
            'json', 'yaml', 'table', 'checklist', 'image',
            'diagram', 'chart', 'config', 'link-list', 'file',
        ]
        for (const k of expected) {
            expect(WORK_KINDS).toContain(k)
        }
    })
})

describe('inferKind — extension-driven fallback', () => {
    test('markdown files are markdown by default', () => {
        expect(inferKind('notes.md').kind).toBe('markdown')
        expect(inferKind('README.markdown').kind).toBe('markdown')
        expect(inferKind('report.mdx').kind).toBe('markdown')
    })

    test('code files get a language hint', () => {
        expect(inferKind('main.ts')).toEqual({ kind: 'code', language: 'typescript' })
        expect(inferKind('script.py')).toEqual({ kind: 'code', language: 'python' })
        expect(inferKind('server.go')).toEqual({ kind: 'code', language: 'go' })
        expect(inferKind('index.js')).toEqual({ kind: 'code', language: 'javascript' })
    })

    test('structured data extensions', () => {
        expect(inferKind('config.json').kind).toBe('json')
        expect(inferKind('playbook.yaml').kind).toBe('yaml')
        expect(inferKind('playbook.yml').kind).toBe('yaml')
        expect(inferKind('users.csv').kind).toBe('table')
    })

    test('html, image, diagram', () => {
        expect(inferKind('page.html').kind).toBe('html')
        expect(inferKind('logo.png').kind).toBe('image')
        expect(inferKind('flow.mmd').kind).toBe('diagram')
    })

    test('config files', () => {
        expect(inferKind('settings.toml').kind).toBe('config')
        expect(inferKind('Dockerfile').kind).toBe('config')
        expect(inferKind('.env').kind).toBe('config')
    })

    test('unknown extension with content falls back to markdown', () => {
        expect(inferKind('weird.xyz', 'hello world').kind).toBe('markdown')
    })

    test('unknown extension with no content falls back to file', () => {
        expect(inferKind('weird.xyz').kind).toBe('file')
    })
})

describe('inferKind — content-aware promotion', () => {
    test('markdown with numbered steps → instructions', () => {
        const content = [
            '# Deploy guide',
            '',
            '1. Install dependencies',
            '2. Configure env vars',
            '3. Run migrations',
            '4. Start the server',
        ].join('\n')
        expect(inferKind('guide.md', content).kind).toBe('instructions')
    })

    test('markdown with "Step N:" pattern → instructions', () => {
        const content = 'Step 1: Clone the repo\nStep 2: Install deps\nStep 3: Run.'
        expect(inferKind('guide.md', content).kind).toBe('instructions')
    })

    test('markdown with link-heavy bullets → link-list', () => {
        const content = [
            '# Resources',
            '',
            '- https://example.com/a',
            '- https://example.com/b',
            '- https://example.com/c',
            '- https://example.com/d',
        ].join('\n')
        expect(inferKind('links.md', content).kind).toBe('link-list')
    })

    test('markdown with prose content stays markdown', () => {
        const content = 'This is just a paragraph of free-form prose without any steps.'
        expect(inferKind('notes.md', content).kind).toBe('markdown')
    })
})

describe('kindToLegacyType', () => {
    test('maps every WorkKind to a legacy type', () => {
        for (const kind of WORK_KINDS) {
            const legacy = kindToLegacyType(kind)
            expect(['markdown', 'code', 'html', 'diagram', 'image', 'file']).toContain(legacy)
        }
    })

    test('specific mappings', () => {
        expect(kindToLegacyType('instructions')).toBe('markdown')
        expect(kindToLegacyType('checklist')).toBe('markdown')
        expect(kindToLegacyType('config')).toBe('code')
        expect(kindToLegacyType('mockup')).toBe('html')
        expect(kindToLegacyType('chart')).toBe('file')
    })
})
