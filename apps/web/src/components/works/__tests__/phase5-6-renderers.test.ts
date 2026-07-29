// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 5/6/7 — pure-logic tests for the interactive renderers and
// the Phase 6 advanced ones. We only test exported pure helpers
// (parseChecklist, parseLinks, parseTabular, toCsv, parseChart,
// detectConfigLanguage) because the web test surface runs under
// node and does not execute DOM / JSX.

import { describe, it, expect } from 'vitest'

import { parseChecklist } from '../renderers/ChecklistRenderer'
import { parseLinks } from '../renderers/LinkListRenderer'
import { parseTabular, toCsv } from '../renderers/TableRenderer'
import { parseChart } from '../renderers/ChartRenderer'
import { detectConfigLanguage } from '../renderers/ConfigRenderer'

// ── ChecklistRenderer ───────────────────────────────────────────────────

describe('parseChecklist', () => {
    it('returns an empty array for empty content', () => {
        expect(parseChecklist('')).toEqual([])
    })

    it('parses unchecked items', () => {
        const items = parseChecklist('- [ ] first\n- [ ] second')
        expect(items).toHaveLength(2)
        expect(items[0]).toMatchObject({ text: 'first', initiallyChecked: false, indent: 0 })
        expect(items[1]).toMatchObject({ text: 'second', initiallyChecked: false })
    })

    it('parses checked items (case-insensitive x)', () => {
        const items = parseChecklist('- [x] one\n- [X] two')
        expect(items).toHaveLength(2)
        expect(items[0]!.initiallyChecked).toBe(true)
        expect(items[1]!.initiallyChecked).toBe(true)
    })

    it('captures indent level from leading whitespace', () => {
        const items = parseChecklist('- [ ] outer\n  - [ ] inner\n    - [ ] deeper')
        expect(items.map(i => i.indent)).toEqual([0, 1, 2])
    })

    it('ignores non-checklist lines', () => {
        const items = parseChecklist('# heading\n\nSome prose\n- [ ] real item\n- plain bullet')
        expect(items).toHaveLength(1)
        expect(items[0]!.text).toBe('real item')
    })

    it('supports asterisk bullet syntax', () => {
        const items = parseChecklist('* [ ] asterisk item')
        expect(items).toHaveLength(1)
        expect(items[0]!.text).toBe('asterisk item')
    })

    it('assigns monotonically increasing indices', () => {
        const items = parseChecklist('- [ ] a\n- [ ] b\n- [ ] c')
        expect(items.map(i => i.index)).toEqual([0, 1, 2])
    })
})

// ── LinkListRenderer ────────────────────────────────────────────────────

describe('parseLinks', () => {
    it('parses empty content to empty array', () => {
        expect(parseLinks('')).toEqual([])
    })

    it('parses markdown-style links', () => {
        const links = parseLinks('- [Claude](https://claude.ai)')
        expect(links).toHaveLength(1)
        expect(links[0]).toMatchObject({
            title: 'Claude',
            url: 'https://claude.ai',
            host: 'claude.ai',
        })
    })

    it('parses markdown links with descriptions', () => {
        const links = parseLinks('- [Anthropic](https://anthropic.com) — the company')
        expect(links[0]!.description).toBe('the company')
    })

    it('parses bare URL bullet lines', () => {
        const links = parseLinks('- https://example.com/path')
        expect(links).toHaveLength(1)
        expect(links[0]!.url).toBe('https://example.com/path')
        expect(links[0]!.host).toBe('example.com')
    })

    it('skips non-link lines', () => {
        const links = parseLinks('# heading\n- [ ] not a link\n- https://valid.com\nplain text')
        expect(links).toHaveLength(1)
        expect(links[0]!.url).toBe('https://valid.com')
    })

    it('handles mixed markdown and bare URLs', () => {
        const links = parseLinks('- [One](https://a.com)\n- https://b.com\n- [Three](https://c.com) — desc')
        expect(links).toHaveLength(3)
        expect(links.map(l => l.host)).toEqual(['a.com', 'b.com', 'c.com'])
    })
})

// ── TableRenderer ───────────────────────────────────────────────────────

describe('parseTabular', () => {
    it('returns null columns for empty content', () => {
        const out = parseTabular({ filename: 'data.csv', content: '' })
        expect(out.columns).toBeNull()
    })

    it('parses basic CSV', () => {
        const out = parseTabular({ filename: 'data.csv', content: 'a,b\n1,2\n3,4' })
        expect(out.columns).toEqual(['a', 'b'])
        expect(out.rows).toHaveLength(2)
        expect(out.rows![0]).toEqual({ a: '1', b: '2' })
    })

    it('parses TSV via filename hint', () => {
        const out = parseTabular({ filename: 'data.tsv', content: 'x\ty\n1\t2' })
        expect(out.columns).toEqual(['x', 'y'])
        expect(out.rows![0]).toEqual({ x: '1', y: '2' })
    })

    it('parses quoted CSV values with commas and escapes', () => {
        const out = parseTabular({ filename: 'q.csv', content: 'name,note\n"A, B","has ""quotes"""' })
        expect(out.rows![0]).toEqual({ name: 'A, B', note: 'has "quotes"' })
    })

    it('parses JSON array input', () => {
        const out = parseTabular({ filename: 'data.json', content: '[{"a":1,"b":2},{"a":3,"b":4}]' })
        expect(out.columns).toEqual(['a', 'b'])
        expect(out.rows).toHaveLength(2)
    })

    it('prefers meta.columns/meta.rows when provided', () => {
        const out = parseTabular({
            filename: 'x.csv',
            content: 'ignored,data\n1,2',
            meta: { columns: ['foo'], rows: [{ foo: 'bar' }] },
        })
        expect(out.columns).toEqual(['foo'])
        expect(out.rows).toEqual([{ foo: 'bar' }])
    })

    it('surfaces errors on invalid JSON array', () => {
        const out = parseTabular({ filename: 'bad.json', content: '[not json' })
        expect(out.error).not.toBeNull()
    })
})

describe('toCsv', () => {
    it('builds a header-only string from empty rows', () => {
        expect(toCsv(['a', 'b'], [])).toBe('a,b')
    })

    it('escapes commas, quotes, and newlines', () => {
        const csv = toCsv(['a', 'b'], [{ a: 'hi, there', b: 'he said "ok"' }])
        expect(csv).toContain('"hi, there"')
        expect(csv).toContain('"he said ""ok"""')
    })

    it('round-trips through parseTabular', () => {
        const rows = [{ x: '1', y: '2' }, { x: '3', y: '4' }]
        const csv = toCsv(['x', 'y'], rows)
        const parsed = parseTabular({ filename: 'x.csv', content: csv })
        expect(parsed.rows).toEqual(rows)
    })

    it('handles objects and nulls', () => {
        const csv = toCsv(['v'], [{ v: { nested: true } }, { v: null }])
        // Object is JSON-stringified then CSV-escaped (inner quotes doubled).
        expect(csv).toContain('""nested""')
        // Null row present as empty field on the trailing line.
        expect(csv.split('\n').at(-1)).toBe('')
    })

    it('stringifies numeric values', () => {
        const csv = toCsv(['n'], [{ n: 42 }, { n: 3.14 }])
        expect(csv).toContain('42')
        expect(csv).toContain('3.14')
    })
})

// ── ChartRenderer ───────────────────────────────────────────────────────

describe('parseChart', () => {
    it('returns null data for empty input', () => {
        expect(parseChart('')).toEqual({ data: null, error: null })
        expect(parseChart(null)).toEqual({ data: null, error: null })
    })

    it('parses a bare array of {x, y} points', () => {
        const out = parseChart('[{"x":"Jan","y":10},{"x":"Feb","y":20}]')
        expect(out.error).toBeNull()
        expect(out.data).toHaveLength(2)
        expect(out.data![0]).toEqual({ x: 'Jan', y: 10 })
    })

    it('parses a bare array of raw numbers', () => {
        const out = parseChart('[1, 2, 3]')
        expect(out.error).toBeNull()
        expect(out.data).toHaveLength(3)
        expect(out.data![2]!.y).toBe(3)
    })

    it('parses { data, xKey, yKey } form', () => {
        const spec = '{"data":[{"label":"A","value":5},{"label":"B","value":8}],"xKey":"label","yKey":"value"}'
        const out = parseChart(spec)
        expect(out.error).toBeNull()
        expect(out.data![0]).toEqual({ x: 'A', y: 5 })
        expect(out.data![1]).toEqual({ x: 'B', y: 8 })
    })

    it('surfaces JSON parse errors', () => {
        const out = parseChart('{not valid}')
        expect(out.data).toBeNull()
        expect(out.error).not.toBeNull()
    })

    it('rejects non-numeric y values', () => {
        const out = parseChart('[{"x":"a","y":"not a number"}]')
        expect(out.data).toBeNull()
        expect(out.error).toContain('Non-numeric')
    })

    it('rejects unsupported shapes', () => {
        const out = parseChart('{"no":"data"}')
        expect(out.error).toContain('Expected')
    })
})

// ── ConfigRenderer ──────────────────────────────────────────────────────

describe('detectConfigLanguage', () => {
    it('detects Dockerfile by bare name', () => {
        expect(detectConfigLanguage('Dockerfile')).toBe('dockerfile')
        expect(detectConfigLanguage('app.dockerfile')).toBe('dockerfile')
    })

    it('detects toml / ini / conf / cfg', () => {
        expect(detectConfigLanguage('pyproject.toml')).toBe('toml')
        expect(detectConfigLanguage('setup.ini')).toBe('ini')
        expect(detectConfigLanguage('nginx.conf')).toBe('ini')
        expect(detectConfigLanguage('my.cfg')).toBe('ini')
    })

    it('detects .env / dotenv files', () => {
        expect(detectConfigLanguage('.env')).toBe('bash')
        expect(detectConfigLanguage('production.env')).toBe('bash')
    })

    it('detects Makefile', () => {
        expect(detectConfigLanguage('Makefile')).toBe('makefile')
        expect(detectConfigLanguage('build.mk')).toBe('makefile')
    })

    it('detects yaml / json / properties', () => {
        expect(detectConfigLanguage('config.yaml')).toBe('yaml')
        expect(detectConfigLanguage('config.yml')).toBe('yaml')
        expect(detectConfigLanguage('schema.json')).toBe('json')
        expect(detectConfigLanguage('app.properties')).toBe('properties')
    })

    it('returns null for unknown filenames', () => {
        expect(detectConfigLanguage('README.txt')).toBeNull()
        expect(detectConfigLanguage('')).toBeNull()
    })

    it('is case-insensitive', () => {
        expect(detectConfigLanguage('DOCKERFILE')).toBe('dockerfile')
        expect(detectConfigLanguage('Config.YAML')).toBe('yaml')
    })
})
