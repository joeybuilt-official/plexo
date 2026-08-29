// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { buildRepoMap, extractSymbols, languageForPath } from './repomap.js'

describe('languageForPath', () => {
    it('maps known extensions', () => {
        expect(languageForPath('src/index.ts')).toBe('typescript')
        expect(languageForPath('a/b/Page.tsx')).toBe('typescript')
        expect(languageForPath('app.py')).toBe('python')
        expect(languageForPath('main.go')).toBe('go')
        expect(languageForPath('lib.rs')).toBe('rust')
    })

    it('normalises case and returns unknown for unsupported', () => {
        expect(languageForPath('Foo.TS')).toBe('typescript')
        expect(languageForPath('readme.md')).toBe('unknown')
        expect(languageForPath('noext')).toBe('unknown')
    })
})

describe('extractSymbols (typescript/javascript)', () => {
    const source = [
        'export function handleAuth(cred: Credential): boolean {',
        '  return true',
        '}',
        'class AuthService {',
        '}',
        'export interface User { id: string }',
        'type Handler = (req: Req) => Res',
        'export enum Role { Admin = 1 }',
        'export const apiUrl = "https://example.com"',
        'export let counter = 0',
        'export var legacy = true',
        'const local = () => {',
        '  const nested = 1',
        '}',
    ].join('\n')

    it('extracts top-level symbols and skips indented locals', () => {
        const syms = extractSymbols('src/auth.ts', source)
        const names = syms.map((s) => s.name)
        expect(names).toContain('handleAuth')
        expect(names).toContain('AuthService')
        expect(names).toContain('User')
        expect(names).toContain('Handler')
        expect(names).toContain('Role')
        expect(names).toContain('apiUrl')
        expect(names).toContain('counter')
        expect(names).toContain('legacy')
        expect(names).toContain('local')
        expect(names).not.toContain('nested')
        const fn = syms.find((s) => s.name === 'handleAuth')!
        expect(fn.kind).toBe('function')
        expect(fn.line).toBe(1)
    })
})

describe('extractSymbols (python)', () => {
    const source = [
        'async def fetch(url):',
        '    return url',
        '',
        'class Client:',
        '    def connect(self):',
        '        pass',
        '',
        'RETRIES = 3',
    ].join('\n')

    it('extracts def/class/const and skips indented methods', () => {
        const syms = extractSymbols('client.py', source)
        const names = syms.map((s) => s.name)
        expect(names).toContain('fetch')
        expect(names).toContain('Client')
        expect(names).toContain('RETRIES')
        expect(names).not.toContain('connect')
    })
})

describe('extractSymbols (go/rust)', () => {
    it('extracts go func/type/var', () => {
        const syms = extractSymbols('main.go', [
            'func NewServer(cfg Config) *Server {',
            '}',
            'type Server struct {',
            '}',
            'var DefaultPort = 8080',
        ].join('\n'))
        expect(syms.map((s) => s.name)).toEqual(['NewServer', 'Server', 'DefaultPort'])
    })

    it('extracts rust fn/struct/enum', () => {
        const syms = extractSymbols('lib.rs', [
            'pub fn render() -> String {',
            '}',
            'pub struct Node {',
            '}',
            'pub enum Kind {',
            '}',
            'impl Node {',
            '  fn private(&self) {}',
            '}',
        ].join('\n'))
        const names = syms.map((s) => s.name)
        expect(names).toContain('render')
        expect(names).toContain('Node')
        expect(names).toContain('Kind')
        expect(names).not.toContain('private')
    })
})

describe('buildRepoMap', () => {
    const files = (query: string) => [
        { relPath: 'src/auth.ts', source: 'export function handleAuth(): void {}\nexport class Session {}' },
        { relPath: 'src/payments.ts', source: 'export function chargeCard(): void {}' },
        { relPath: 'README.md', source: 'export function notParsed(): void {}' },
    ]

    it('returns empty string when no file has symbols', () => {
        expect(buildRepoMap([{ relPath: 'a.txt', source: 'nothing here' }])).toBe('')
        expect(buildRepoMap([])).toBe('')
    })

    it('omits unsupported-language files', () => {
        const out = buildRepoMap([{ relPath: 'x.md', source: 'export function f() {}' }])
        expect(out).toBe('')
    })

    it('ranks files by lexical relevance to the query', () => {
        const out = buildRepoMap(files('payments'), { query: ['charge a payment'] })
        const paymentsIdx = out.indexOf('src/payments.ts')
        const authIdx = out.indexOf('src/auth.ts')
        expect(paymentsIdx).toBeGreaterThan(-1)
        expect(authIdx).toBeGreaterThan(-1)
        expect(paymentsIdx).toBeLessThan(authIdx)
    })

    it('lists path then indented symbol lines', () => {
        const out = buildRepoMap(files('auth'), { query: ['auth'] })
        expect(out).toContain('REPOSITORY MAP')
        expect(out).toContain('src/auth.ts')
        expect(out).toContain('function handleAuth :1')
        expect(out).toContain('class Session :2')
    })

    it('respects maxFiles / maxSymbolsPerFile / maxOutputChars caps', () => {
        const manyFiles = Array.from({ length: 20 }, (_, i) => ({
            relPath: `f${i}.ts`,
            source: Array.from({ length: 50 }, (_, j) => `export function fn${j}(): void {}`).join('\n'),
        }))
        const out = buildRepoMap(manyFiles, { maxFiles: 3, maxSymbolsPerFile: 5, maxOutputChars: 200 })
        const fileLines = out.split('\n').filter((l) => l.startsWith('f'))
        expect(fileLines.length).toBeLessThanOrEqual(3)
        const symbols = out.split('\n').filter((l) => l.startsWith('  '))
        expect(symbols.length).toBeLessThanOrEqual(18)
    })

    it('never leaks symbol literal values (name + kind + line only)', () => {
        const out = buildRepoMap([{ relPath: 'secrets.ts', source: 'const apiKey = "sk-live-12345abc"', }], { query: ['key'] })
        expect(out).toContain('apiKey')
        expect(out).not.toContain('sk-live-12345abc')
        expect(out).not.toContain('sk-live')
    })

    it('is deterministic for equal scores', () => {
        const fs = [
            { relPath: 'b.ts', source: 'export function x(): void {}' },
            { relPath: 'a.ts', source: 'export function y(): void {}' },
        ]
        expect(buildRepoMap(fs)).toBe(buildRepoMap([...fs].reverse()))
    })
})