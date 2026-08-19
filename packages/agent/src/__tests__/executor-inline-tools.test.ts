// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * DD-3 — inline streaming chat path: the code tools (read_file, write_file,
 * edit_file, grep, glob, shell) that chat.ts pulls from buildTools MUST emit
 * the same step.* event shapes the workbench already renders. The inline path
 * wires ctx.emitStepEvent → emitToWorkspace, and use-code-stream subscribes to
 * that channel — so a write_file in an inline chat turn must produce a
 * step.file_write event identical to a queued-task write_file.
 *
 * These tests exercise buildTools + dispatchTool directly with a spy
 * emitStepEvent and a tmp workdir, asserting the event contract without a live
 * model or SSE response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTools } from '../executor/index.js'
import type { ExecutionContext, StepEvent } from '../types.js'

function makeCtx(workDir: string, emit: (e: StepEvent) => void): ExecutionContext {
    return {
        taskId: 'chat-test-task',
        workspaceId: 'ws-test',
        userId: 'test',
        credential: { apiKey: 'mock' } as unknown as ExecutionContext['credential'],
        taskType: 'coding',
        tokenBudget: 0,
        taskCostCeilingUsd: null,
        signal: new AbortController().signal,
        sprintWorkDir: workDir,
        emitStepEvent: emit,
    } as ExecutionContext
}

describe('DD-3: buildTools code tools emit step.* events for the inline streaming path', () => {
    let workDir: string
    let events: StepEvent[]

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'plexo-inline-'))
        events = []
    })
    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true })
    })

    it('write_file emits a step.file_write event with a unified-diff patch', async () => {
        const ctx = makeCtx(workDir, (e) => events.push(e))
        const tools = buildTools(ctx, null) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>
        const target = join(workDir, 'src', 'foo.ts')

        const out = await tools.write_file!.execute({ path: 'src/foo.ts', content: 'export const x = 1\n' })

        expect(out).toMatch(/OK: wrote/)
        const fw = events.find((e) => e.type === 'step.file_write')
        expect(fw).toBeDefined()
        expect(fw!.type).toBe('step.file_write')
        // path is relative to the workdir
        expect((fw as { path: string }).path).toBe('src/foo.ts')
        // patch is a unified diff (new file → contains +++ and --- headers)
        expect((fw as { patch: string }).patch).toContain('+++')
        expect(readFileSync(target, 'utf8')).toBe('export const x = 1\n')
    })

    it('edit_file emits a step.file_write event with the diff of the change', async () => {
        const ctx = makeCtx(workDir, (e) => events.push(e))
        const tools = buildTools(ctx, null) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>
        writeFileSync(join(workDir, 'bar.ts'), 'export const y = 1\n')

        const patch = `--- a/bar.ts\n+++ b/bar.ts\n@@ -1 +1 @@\n-export const y = 1\n+export const y = 2\n`
        const out = await tools.edit_file!.execute({ path: 'bar.ts', patch })

        expect(out).toMatch(/OK: patched/)
        const fw = events.find((e) => e.type === 'step.file_write')
        expect(fw).toBeDefined()
        expect((fw as { path: string }).path).toBe('bar.ts')
        expect((fw as { patch: string }).patch).toContain('-export const y = 1')
        expect((fw as { patch: string }).patch).toContain('+export const y = 2')
        expect(readFileSync(join(workDir, 'bar.ts'), 'utf8')).toBe('export const y = 2\n')
    })

    it('read_file, grep, glob are present in buildTools output', () => {
        const ctx = makeCtx(workDir, () => {})
        const tools = buildTools(ctx, null) as Record<string, unknown>
        expect(tools).toHaveProperty('read_file')
        expect(tools).toHaveProperty('grep')
        expect(tools).toHaveProperty('glob')
        expect(tools).toHaveProperty('shell')
    })

    it('grep returns matches without emitting step events (read-only tool)', async () => {
        const ctx = makeCtx(workDir, (e) => events.push(e))
        const tools = buildTools(ctx, null) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>
        writeFileSync(join(workDir, 'a.txt'), 'hello world\nfoo bar\n')

        const out = await tools.grep!.execute({ pattern: 'foo', path: '.' })
        expect(out).toContain('foo bar')
        // grep is read-only — no step.file_write or step.shell_line events
        expect(events.filter((e) => e.type === 'step.file_write' || e.type === 'step.shell_line')).toHaveLength(0)
    })
})