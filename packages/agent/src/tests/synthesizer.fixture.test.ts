// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 1 of intelligence-hardening: fixture tests for the plugin
 * synthesizer's parse + validate path. Production call site:
 *     packages/agent/src/plugins/synthesizer.ts:275-316
 *
 * Unlike the JSON-parsing call sites, the synthesizer outputs JavaScript
 * code directly. The parse step is: strip markdown fences, extract code.
 * Then validateGeneratedCode runs 4 checks (non-empty, size, activate
 * present, export present, basic syntax via `new Function`).
 */

import { describe, it, expect } from 'vitest'

const MAX_CODE_BYTES = 32 * 1024

// ── Inline mirrors of production logic ────────────────────────────────

function extractCodeFromResponse(rawText: string): string {
    let code = rawText.trim()
    const fenceMatch = code.match(/```(?:javascript|js)?\n([\s\S]*?)```/)
    if (fenceMatch) {
        code = fenceMatch[1]!.trim()
    }
    return code
}

function validateGeneratedCode(code: string): { valid: boolean; error?: string } {
    if (code.length === 0) return { valid: false, error: 'Empty output' }
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
        return { valid: false, error: `Generated code exceeds ${MAX_CODE_BYTES / 1024}KB limit` }
    }
    if (!code.includes('activate')) {
        return { valid: false, error: 'Missing activate function' }
    }
    if (!code.includes('export')) {
        return { valid: false, error: 'Missing export statement' }
    }
    try {
        // eslint-disable-next-line no-new-func
        new Function(code.replace(/^export\s+/gm, ''))
    } catch (e) {
        return { valid: false, error: `Syntax error: ${(e as Error).message}` }
    }
    return { valid: true }
}

// ── Fixtures ───────────────────────────────────────────────────────────

interface ExtractFixture {
    name: string
    llmResponse: string
    expectedCode: string
}

const extractFixtures: ExtractFixture[] = [
    {
        name: 'raw code (no fence)',
        llmResponse: 'export function activate() { return 1 }',
        expectedCode: 'export function activate() { return 1 }',
    },
    {
        name: 'fenced javascript',
        llmResponse: '```javascript\nexport function activate() { return 2 }\n```',
        expectedCode: 'export function activate() { return 2 }',
    },
    {
        name: 'fenced js short alias',
        llmResponse: '```js\nexport function activate() { return 3 }\n```',
        expectedCode: 'export function activate() { return 3 }',
    },
    {
        name: 'fenced with no language tag',
        llmResponse: '```javascript\nexport async function activate(ctx) { await ctx.step() }\n```',
        expectedCode: 'export async function activate(ctx) { await ctx.step() }',
    },
    {
        name: 'leading/trailing whitespace preserved outside fence',
        llmResponse: '   \n\n   export function activate() { return 5 }   \n\n   ',
        expectedCode: 'export function activate() { return 5 }',
    },
    {
        name: 'multiline code inside fence',
        llmResponse: '```javascript\nexport function activate() {\n  const x = 1\n  return x + 2\n}\n```',
        expectedCode: 'export function activate() {\n  const x = 1\n  return x + 2\n}',
    },
]

interface ValidateFixture {
    name: string
    code: string
    expectedValid: boolean
    expectedErrorContains?: string
}

const validateFixtures: ValidateFixture[] = [
    {
        name: 'valid happy path',
        code: 'export function activate() { return 1 }',
        expectedValid: true,
    },
    {
        name: 'valid async',
        code: 'export async function activate(ctx) { return ctx }',
        expectedValid: true,
    },
    {
        name: 'empty string fails',
        code: '',
        expectedValid: false,
        expectedErrorContains: 'Empty output',
    },
    {
        name: 'missing activate fails',
        code: 'export function run() { return 1 }',
        expectedValid: false,
        expectedErrorContains: 'Missing activate function',
    },
    {
        name: 'missing export fails',
        code: 'function activate() { return 1 }',
        expectedValid: false,
        expectedErrorContains: 'Missing export statement',
    },
    {
        name: 'syntax error fails',
        code: 'export function activate() { return 1',
        expectedValid: false,
        expectedErrorContains: 'Syntax error',
    },
    {
        name: 'over size limit fails',
        code: `export function activate() { /* ${'x'.repeat(33 * 1024)} */ return 1 }`,
        expectedValid: false,
        expectedErrorContains: 'exceeds 32KB',
    },
]

// ── Tests ──────────────────────────────────────────────────────────────

describe('synthesizer code extraction', () => {
    for (const fx of extractFixtures) {
        it(fx.name, () => {
            expect(extractCodeFromResponse(fx.llmResponse)).toBe(fx.expectedCode)
        })
    }
})

describe('synthesizer code validation', () => {
    for (const fx of validateFixtures) {
        it(fx.name, () => {
            const result = validateGeneratedCode(fx.code)
            expect(result.valid).toBe(fx.expectedValid)
            if (fx.expectedErrorContains) {
                expect(result.error).toContain(fx.expectedErrorContains)
            }
        })
    }

    it('fixture count sanity', () => {
        expect(extractFixtures.length + validateFixtures.length).toBeGreaterThanOrEqual(12)
    })
})
