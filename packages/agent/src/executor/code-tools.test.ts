// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    applyUnifiedPatch,
    PatchError,
    grepSearchSync,
    globSearchSync,
    formatGrepRows,
    globToRegExp,
} from './code-tools.js'

describe('applyUnifiedPatch', () => {
    it('applies a clean single-hunk patch', () => {
        const content = 'line one\nline two\nline three\nline four'
        const patch = [
            '--- a/f.txt',
            '+++ b/f.txt',
            '@@ -1,4 +1,4 @@',
            ' line one',
            '-line two',
            '+line TWO edited',
            ' line three',
            ' line four',
        ].join('\n')
        const { result, bytesChanged } = applyUnifiedPatch(content, patch)
        expect(result).toBe('line one\nline TWO edited\nline three\nline four')
        expect(bytesChanged).toBe(Buffer.byteLength(result, 'utf8') - Buffer.byteLength(content, 'utf8'))
    })

    it('rejects on context mismatch (no partial write)', () => {
        const content = 'alpha\nbeta\ngamma'
        const patch = [
            '@@ -1,3 +1,3 @@',
            ' alpha',
            '-WRONG',
            '+beta edited',
            ' gamma',
        ].join('\n')
        expect(() => applyUnifiedPatch(content, patch)).toThrow(PatchError)
        expect(() => applyUnifiedPatch(content, patch)).toThrow(/Context mismatch/)
    })

    it('rejects when file is shorter than hunk expects', () => {
        const content = 'only one line'
        const patch = [
            '@@ -1,3 +1,3 @@',
            ' only one line',
            ' second',
            ' third',
        ].join('\n')
        expect(() => applyUnifiedPatch(content, patch)).toThrow(PatchError)
        expect(() => applyUnifiedPatch(content, patch)).toThrow(/exceeds file length/)
    })

    it('rejects malformed hunk header', () => {
        expect(() => applyUnifiedPatch('x', 'not a patch')).toThrow(PatchError)
        expect(() => applyUnifiedPatch('x', 'no hunks here')).toThrow(/No hunks/)
    })

    it('handles a pure-addition hunk (oldLen 0)', () => {
        const content = 'a\nb'
        const patch = [
            '@@ -0,0 +1,1 @@',
            '+inserted',
        ].join('\n')
        const { result } = applyUnifiedPatch(content, patch)
        expect(result).toBe('inserted\na\nb')
    })

    it('applies multiple sequential hunks with offset tracking', () => {
        const content = 'a\nb\nc\nd\ne\nf'
        const patch = [
            '@@ -1,2 +1,2 @@',
            ' a',
            '-b',
            '+B',
            '@@ -4,2 +4,2 @@',
            ' d',
            '-e',
            '+E',
        ].join('\n')
        const { result } = applyUnifiedPatch(content, patch)
        expect(result).toBe('a\nB\nc\nd\nE\nf')
    })
})

describe('globToRegExp', () => {
    it('matches single-segment *', () => {
        const re = globToRegExp('*.ts')
        expect(re.test('foo.ts')).toBe(true)
        expect(re.test('dir/foo.ts')).toBe(false)
        expect(re.test('foo.js')).toBe(false)
    })
    it('matches ** across segments', () => {
        const re = globToRegExp('src/**/*.ts')
        expect(re.test('src/a.ts')).toBe(true)
        expect(re.test('src/sub/deep/a.ts')).toBe(true)
        expect(re.test('src/a.js')).toBe(false)
    })
    it('matches {a,b} alternation', () => {
        const re = globToRegExp('*.{js,ts}')
        expect(re.test('foo.js')).toBe(true)
        expect(re.test('foo.ts')).toBe(true)
        expect(re.test('foo.json')).toBe(false)
    })
    it('matches ? single char', () => {
        const re = globToRegExp('?.ts')
        expect(re.test('a.ts')).toBe(true)
        expect(re.test('ab.ts')).toBe(false)
    })
})

describe('grepSearchSync', () => {
    let dir: string
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'plexo-grep-'))
        mkdirSync(join(dir, 'src'), { recursive: true })
        writeFileSync(join(dir, 'src', 'a.ts'), 'export const FOO = 1\nexport const bar = 2\n')
        writeFileSync(join(dir, 'src', 'b.md'), '# Title\nFOO mention\n')
        mkdirSync(join(dir, 'node_modules'), { recursive: true })
        writeFileSync(join(dir, 'node_modules', 'x'), 'ignored\n')
    })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('returns file:line: match rows', () => {
        const rows = grepSearchSync({ root: dir, pattern: 'FOO' })
        expect(rows.length).toBe(2)
        expect(rows[0]!.file).toBe('src/a.ts')
        expect(rows[0]!.line).toBe(1)
        expect(rows[0]!.match).toContain('FOO')
        expect(rows.some(r => r.file === 'src/b.md' && r.line === 2)).toBe(true)
    })

    it('ignoreCase lowers the match threshold', () => {
        const rows = grepSearchSync({ root: dir, pattern: 'foo', ignoreCase: true })
        expect(rows.length).toBe(2)
    })

    it('case-sensitive returns nothing for wrong case', () => {
        const rows = grepSearchSync({ root: dir, pattern: 'foo' })
        expect(rows.length).toBe(0)
    })

    it('respects maxResults cap', () => {
        const rows = grepSearchSync({ root: dir, pattern: 'export|FOO|Title', maxResults: 1 })
        expect(rows.length).toBe(1)
    })

    it('glob filter restricts by path', () => {
        const rows = grepSearchSync({ root: dir, pattern: 'FOO', glob: '*.ts' })
        expect(rows.length).toBe(1)
        expect(rows[0]!.file).toBe('src/a.ts')
    })

    it('skips node_modules', () => {
        const rows = grepSearchSync({ root: dir, pattern: 'ignored' })
        expect(rows.length).toBe(0)
    })

    it('formatGrepRows renders rows', () => {
        const out = formatGrepRows([{ file: 'a.ts', line: 3, match: 'hi' }])
        expect(out).toBe('a.ts:3: hi')
        expect(formatGrepRows([])).toBe('(no matches)')
    })
})

describe('globSearchSync', () => {
    let dir: string
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'plexo-glob-'))
        mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
        writeFileSync(join(dir, 'src', 'a.ts'), 'x')
        writeFileSync(join(dir, 'src', 'deep', 'b.ts'), 'x')
        writeFileSync(join(dir, 'src', 'c.js'), 'x')
        writeFileSync(join(dir, 'root.md'), 'x')
    })
    afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

    it('matches **/*.ts', () => {
        const out = globSearchSync({ root: dir, pattern: '**/*.ts' })
        expect(out).toContain('src/a.ts')
        expect(out).toContain('src/deep/b.ts')
        expect(out).not.toContain('src/c.js')
    })

    it('matches {js,ts} alternation', () => {
        const out = globSearchSync({ root: dir, pattern: 'src/*.{js,ts}' })
        expect(out).toContain('src/a.ts')
        expect(out).toContain('src/c.js')
        expect(out).not.toContain('src/deep/b.ts')
    })

    it('respects limit', () => {
        const out = globSearchSync({ root: dir, pattern: '**/*', limit: 2 })
        expect(out.length).toBe(2)
    })

    it('returns empty for no matches', () => {
        const out = globSearchSync({ root: dir, pattern: '**/*.nope' })
        expect(out).toEqual([])
    })
})