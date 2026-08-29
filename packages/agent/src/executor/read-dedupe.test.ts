// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * B13 — identical read-only call dedupe. Verifies the per-task read cache:
 *  - identical read_file args return the same content,
 *  - a mutation (write_file) invalidates the cache so a re-read sees fresh content,
 *  - stableStringify keys objects canonicalised by key order.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTools, clearTaskReadCache, stableStringify } from './index.js'
import type { ExecutionContext } from '../types.js'

function makeCtx(workDir: string): ExecutionContext {
    return {
        taskId: 'b13-task',
        workspaceId: 'ws-test',
        userId: 'test',
        credential: { apiKey: 'mock' } as unknown as ExecutionContext['credential'],
        taskType: 'coding',
        tokenBudget: 0,
        taskCostCeilingUsd: null,
        signal: new AbortController().signal,
        sprintWorkDir: workDir,
    } as ExecutionContext
}

type ExecTool = { execute: (input: Record<string, unknown>) => Promise<unknown> }

describe('B13 read dedupe', () => {
    let workDir: string
    let tools: Record<string, unknown>
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'plexo-dedupe-'))
        tools = buildTools(makeCtx(workDir), null) as unknown as Record<string, ExecTool>
    })
    afterEach(() => {
        clearTaskReadCache('b13-task')
        rmSync(workDir, { recursive: true, force: true })
    })

    it('returns identical content for repeated identical reads', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'hello', 'utf8')
        const first = await (tools.read_file as ExecTool).execute({ path: 'a.txt' })
        const second = await (tools.read_file as ExecTool).execute({ path: 'a.txt' })
        expect(first).toBe('hello')
        expect(second).toBe('hello')
    })

    it('invalidates the read cache after a mutation (edit-then-re-read sees fresh content)', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'v1', 'utf8')
        const before = await (tools.read_file as ExecTool).execute({ path: 'a.txt' })
        expect(before).toContain('v1')
        await (tools.write_file as ExecTool).execute({ path: 'a.txt', content: 'v2' })
        const after = await (tools.read_file as ExecTool).execute({ path: 'a.txt' })
        expect(after).toContain('v2')
        expect(after).not.toContain('v1')
    })

    it('keeps distinct paths as distinct cache entries', async () => {
        writeFileSync(join(workDir, 'a.txt'), 'A', 'utf8')
        writeFileSync(join(workDir, 'b.txt'), 'B', 'utf8')
        const a = await (tools.read_file as ExecTool).execute({ path: 'a.txt' })
        const b = await (tools.read_file as ExecTool).execute({ path: 'b.txt' })
        expect(a).toContain('A')
        expect(b).toContain('B')
    })
})

describe('stableStringify', () => {
    it('canonicalises object key order', () => {
        expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }))
    })

    it('handles primitives and nested objects', () => {
        expect(stableStringify('x')).toBe('"x"')
        expect(stableStringify({ n: { z: 1, a: [2, { q: 3 }] } })).toBe(
            stableStringify({ n: { a: [2, { q: 3 }], z: 1 } }),
        )
    })
})