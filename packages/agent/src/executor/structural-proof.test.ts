// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { extractTouchedFiles } from './structural-proof.js'

// Helper to build a step with typed tool calls
function makeStep(calls: Array<{ tool: string; input: unknown }>) {
    return { toolCalls: calls }
}

describe('extractTouchedFiles', () => {
    const workDir = '/workspace/project'

    it('returns empty array for empty steps', () => {
        expect(extractTouchedFiles([], workDir)).toEqual([])
    })

    it('returns empty array when no write_file calls exist', () => {
        const steps = [
            makeStep([{ tool: 'read_file', input: { path: '/tmp/foo.ts' } }]),
            makeStep([{ tool: 'run_bash', input: { command: 'ls' } }]),
        ]
        expect(extractTouchedFiles(steps, workDir)).toEqual([])
    })

    it('extracts absolute paths from write_file calls unchanged', () => {
        const steps = [
            makeStep([{ tool: 'write_file', input: { path: '/absolute/path/foo.ts', content: 'x' } }]),
        ]
        const result = extractTouchedFiles(steps, workDir)
        expect(result).toContain('/absolute/path/foo.ts')
    })

    it('resolves relative paths against workDir', () => {
        const steps = [
            makeStep([{ tool: 'write_file', input: { path: 'src/app.ts', content: 'x' } }]),
        ]
        const result = extractTouchedFiles(steps, workDir)
        expect(result).toContain(resolve(workDir, 'src/app.ts'))
    })

    it('deduplicates identical paths across multiple steps', () => {
        const steps = [
            makeStep([{ tool: 'write_file', input: { path: '/abs/foo.ts', content: 'v1' } }]),
            makeStep([{ tool: 'write_file', input: { path: '/abs/foo.ts', content: 'v2' } }]),
        ]
        const result = extractTouchedFiles(steps, workDir)
        expect(result.filter(p => p === '/abs/foo.ts')).toHaveLength(1)
    })

    it('collects multiple distinct paths from multiple steps', () => {
        const steps = [
            makeStep([
                { tool: 'write_file', input: { path: '/a/foo.ts', content: '' } },
                { tool: 'write_file', input: { path: '/a/bar.ts', content: '' } },
            ]),
            makeStep([{ tool: 'write_file', input: { path: '/a/baz.ts', content: '' } }]),
        ]
        const result = extractTouchedFiles(steps, workDir)
        expect(result).toContain('/a/foo.ts')
        expect(result).toContain('/a/bar.ts')
        expect(result).toContain('/a/baz.ts')
        expect(result).toHaveLength(3)
    })

    it('ignores write_file calls with missing path in input', () => {
        const steps = [
            makeStep([{ tool: 'write_file', input: { content: 'no path here' } }]),
        ]
        expect(extractTouchedFiles(steps, workDir)).toEqual([])
    })

    it('ignores non-write_file tools even if they have a path field', () => {
        const steps = [
            makeStep([{ tool: 'read_file', input: { path: '/should/not/appear.ts' } }]),
            makeStep([{ tool: 'delete_file', input: { path: '/also/not/appear.ts' } }]),
        ]
        expect(extractTouchedFiles(steps, workDir)).toEqual([])
    })

    it('handles steps with mixed tool types correctly', () => {
        const steps = [
            makeStep([
                { tool: 'run_bash', input: { command: 'npm test' } },
                { tool: 'write_file', input: { path: '/out/result.ts', content: '' } },
                { tool: 'read_file', input: { path: '/src/input.ts' } },
            ]),
        ]
        const result = extractTouchedFiles(steps, workDir)
        expect(result).toEqual(['/out/result.ts'])
    })

    it('handles step with empty toolCalls array', () => {
        const steps = [makeStep([])]
        expect(extractTouchedFiles(steps, workDir)).toEqual([])
    })
})
