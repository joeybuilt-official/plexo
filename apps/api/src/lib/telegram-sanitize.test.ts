// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { sanitizeForTelegram, sanitizeForSlack, sanitizeForDiscord } from './telegram-sanitize.js'

describe('sanitizeForTelegram (plain mode, default)', () => {
    it('strips bold markdown', () => {
        expect(sanitizeForTelegram('**bold** text')).toBe('bold text')
    })

    it('strips italic and underscore italic', () => {
        expect(sanitizeForTelegram('this is *italic* and _also italic_')).toBe('this is italic and also italic')
    })

    it('strips inline code', () => {
        expect(sanitizeForTelegram('run `npm install` first')).toBe('run npm install first')
    })

    it('preserves fenced code blocks as indented plain text', () => {
        const input = '```js\nconst x = 1\nconsole.log(x)\n```'
        const out = sanitizeForTelegram(input)
        expect(out).toContain('const x = 1')
        expect(out).toContain('console.log(x)')
        expect(out).not.toContain('```')
    })

    it('handles the actual failing Telegram message pattern', () => {
        const input = 'Here is what I found: **Plexo** is a platform with these **key features**: fast, open, flexible.'
        const out = sanitizeForTelegram(input)
        expect(out).not.toContain('**')
        expect(out).toContain('Plexo')
        expect(out).toContain('key features')
    })

    it('converts markdown links to label (url)', () => {
        expect(sanitizeForTelegram('See [the docs](https://plexo.dev/docs)')).toBe('See the docs (https://plexo.dev/docs)')
    })

    it('preserves bare URLs', () => {
        expect(sanitizeForTelegram('Visit https://example.com for more')).toBe('Visit https://example.com for more')
    })

    it('strips headers', () => {
        const input = '# Title\n\n## Subtitle\n\nbody text'
        const out = sanitizeForTelegram(input)
        expect(out).not.toContain('#')
        expect(out).toContain('Title')
        expect(out).toContain('Subtitle')
        expect(out).toContain('body text')
    })

    it('converts bullet lists to readable dash prefix', () => {
        const input = '- first\n- second\n- third'
        const out = sanitizeForTelegram(input)
        expect(out).toBe('- first\n- second\n- third')
    })

    it('strips blockquotes', () => {
        expect(sanitizeForTelegram('> quoted line\nnormal line')).toBe('quoted line\nnormal line')
    })

    it('handles nested formatting: bold inside code is left alone, bold around code is stripped', () => {
        const input = '**important:** run `echo hello`'
        const out = sanitizeForTelegram(input)
        expect(out).toBe('important: run echo hello')
    })

    it('strips emoji in default plain mode', () => {
        const input = 'Done ✅ everything worked 🎉'
        const out = sanitizeForTelegram(input)
        expect(out).not.toMatch(/[\u{1F000}-\u{1FFFF}]/u)
        expect(out).toContain('Done')
        expect(out).toContain('everything worked')
    })

    it('handles multiple paragraphs', () => {
        const input = 'First paragraph.\n\nSecond paragraph with **bold**.\n\nThird.'
        const out = sanitizeForTelegram(input)
        expect(out).toBe('First paragraph.\n\nSecond paragraph with bold.\n\nThird.')
    })

    it('strips horizontal rules', () => {
        const input = 'Top\n\n---\n\nBottom'
        const out = sanitizeForTelegram(input)
        expect(out).not.toContain('---')
        expect(out).toContain('Top')
        expect(out).toContain('Bottom')
    })

    it('strips strikethrough', () => {
        expect(sanitizeForTelegram('~~old~~ new')).toBe('old new')
    })

    it('empty string → empty string', () => {
        expect(sanitizeForTelegram('')).toBe('')
    })

    it('plain text passes through unchanged', () => {
        expect(sanitizeForTelegram('Just a normal sentence.')).toBe('Just a normal sentence.')
    })

    it('regression: the exact byte-offset parse-error pattern', () => {
        // Shape that triggered 400: Can't find end of entity
        const input = 'Sure — **here you go**: the answer is `42` and you can read more at [this link](https://x.com).'
        const out = sanitizeForTelegram(input)
        expect(out).not.toContain('**')
        expect(out).not.toContain('`')
        expect(out).not.toContain('[')
        expect(out).toContain('42')
        expect(out).toContain('https://x.com')
    })
})

describe('sanitizeForTelegram (html mode)', () => {
    it('converts bold to <b>', () => {
        expect(sanitizeForTelegram('**bold**', 'html')).toContain('<b>bold</b>')
    })

    it('converts italic to <i>', () => {
        const out = sanitizeForTelegram('*italic*', 'html')
        expect(out).toContain('<i>italic</i>')
    })

    it('converts inline code to <code>', () => {
        expect(sanitizeForTelegram('`code`', 'html')).toContain('<code>code</code>')
    })

    it('converts links to <a href>', () => {
        const out = sanitizeForTelegram('[label](https://x.com)', 'html')
        expect(out).toContain('<a href="https://x.com">label</a>')
    })

    it('escapes HTML special chars', () => {
        const out = sanitizeForTelegram('1 < 2 & 3 > 2', 'html')
        expect(out).toContain('&lt;')
        expect(out).toContain('&gt;')
        expect(out).toContain('&amp;')
    })

    it('wraps code blocks in <pre>', () => {
        const out = sanitizeForTelegram('```\ncode here\n```', 'html')
        expect(out).toContain('<pre>')
        expect(out).toContain('code here')
    })
})

describe('sanitizeForTelegram (markdownv2 mode)', () => {
    it('escapes special characters', () => {
        const out = sanitizeForTelegram('hello. world!', 'markdownv2')
        expect(out).toContain('\\.')
        expect(out).toContain('\\!')
    })

    it('preserves bold as MDv2 single-asterisk', () => {
        const out = sanitizeForTelegram('**bold**', 'markdownv2')
        expect(out).toContain('*bold*')
    })
})

describe('sanitizeForSlack', () => {
    it('converts **bold** to *bold*', () => {
        expect(sanitizeForSlack('**hello**')).toBe('*hello*')
    })

    it('converts markdown links to slack angle format', () => {
        expect(sanitizeForSlack('[label](https://x.com)')).toBe('<https://x.com|label>')
    })

    it('converts ~~strike~~ to ~strike~', () => {
        expect(sanitizeForSlack('~~gone~~')).toBe('~gone~')
    })

    it('preserves triple-backtick code blocks', () => {
        const input = '```js\nconst x = 1\n```'
        const out = sanitizeForSlack(input)
        expect(out).toContain('```')
        expect(out).toContain('const x = 1')
    })

    it('emoji passes through unchanged', () => {
        expect(sanitizeForSlack('done ✅')).toContain('✅')
    })

    it('headers become bold', () => {
        const out = sanitizeForSlack('# Title\nbody')
        expect(out).toContain('*Title*')
        expect(out).toContain('body')
    })
})

describe('sanitizeForDiscord', () => {
    it('leaves standard markdown alone', () => {
        expect(sanitizeForDiscord('**bold** and *italic*')).toBe('**bold** and *italic*')
    })

    it('preserves code blocks', () => {
        const input = '```python\nprint(1)\n```'
        const out = sanitizeForDiscord(input)
        expect(out).toContain('```')
        expect(out).toContain('print(1)')
    })

    it('converts headers to bold for client safety', () => {
        expect(sanitizeForDiscord('# Hello\nworld')).toContain('**Hello**')
    })

    it('emoji passes through unchanged', () => {
        expect(sanitizeForDiscord('done 🎉')).toContain('🎉')
    })

    it('drops horizontal rules', () => {
        const out = sanitizeForDiscord('top\n\n---\n\nbottom')
        expect(out).not.toContain('---')
    })
})
