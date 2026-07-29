// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { htmlToText, parseDuckDuckGoHtml, decodeEntities, stripTags } from './web-tools.js'

describe('htmlToText', () => {
    it('strips tags and normalises whitespace', () => {
        const html = '<html><body><h1>Title</h1><p>Hello <strong>world</strong></p></body></html>'
        expect(htmlToText(html)).toContain('Title')
        expect(htmlToText(html)).toContain('Hello world')
        expect(htmlToText(html)).not.toContain('<')
    })

    it('removes script and style content entirely', () => {
        const html = '<html><head><style>.foo{color:red}</style><script>alert(1)</script></head><body><p>visible</p></body></html>'
        const text = htmlToText(html)
        expect(text).toContain('visible')
        expect(text).not.toContain('alert')
        expect(text).not.toContain('color:red')
    })

    it('decodes HTML entities', () => {
        const html = '<p>Tom &amp; Jerry &mdash; best friends</p>'
        const text = htmlToText(html)
        expect(text).toContain('Tom & Jerry')
        expect(text).toContain('—')
    })

    it('preserves paragraph breaks as newlines', () => {
        const html = '<p>First paragraph</p><p>Second paragraph</p>'
        const text = htmlToText(html)
        expect(text).toMatch(/First paragraph\s+Second paragraph/)
    })

    it('handles empty input', () => {
        expect(htmlToText('')).toBe('')
        expect(htmlToText('   ')).toBe('')
    })
})

describe('parseDuckDuckGoHtml', () => {
    it('extracts results from a representative DDG result page', () => {
        const html = `
<html><body>
<div class="result results_links">
  <div class="result__body">
    <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdocs&amp;rut=abc">Node.js docs</a></h2>
    <a class="result__snippet" href="https://nodejs.org/en/docs">The official Node.js documentation site.</a>
  </div>
</div>
<div class="result results_links">
  <div class="result__body">
    <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Example guide</a></h2>
    <a class="result__snippet" href="https://example.com/guide">A practical guide to examples.</a>
  </div>
</div>
</body></html>`
        const results = parseDuckDuckGoHtml(html, 5)
        expect(results.length).toBeGreaterThanOrEqual(1)
        expect(results[0]?.title).toContain('Node.js')
        expect(results[0]?.url).toBe('https://nodejs.org/en/docs')
        expect(results[0]?.snippet).toContain('documentation')
    })

    it('respects maxResults', () => {
        const block = (i: number) => `
<div class="result">
  <div class="result__body">
    <a class="result__a" href="https://example.com/${i}">Result ${i}</a>
    <a class="result__snippet">Snippet ${i}</a>
  </div>
</div>`
        const html = Array.from({ length: 10 }, (_, i) => block(i)).join('\n')
        expect(parseDuckDuckGoHtml(html, 3).length).toBeLessThanOrEqual(3)
    })

    it('returns [] for pages with no results', () => {
        expect(parseDuckDuckGoHtml('<html><body>nothing here</body></html>', 5)).toEqual([])
    })
})

describe('decodeEntities', () => {
    it('decodes numeric and named entities', () => {
        expect(decodeEntities('&amp;')).toBe('&')
        expect(decodeEntities('&#39;')).toBe("'")
        expect(decodeEntities('&#x27;')).toBe("'")
        expect(decodeEntities('&mdash;')).toBe('—')
    })
})

describe('stripTags', () => {
    it('removes all HTML tags', () => {
        expect(stripTags('<b>hello <i>world</i></b>')).toBe('hello world')
    })
})
