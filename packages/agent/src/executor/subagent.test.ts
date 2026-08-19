// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * DD-4 — spawn_subagent tool: buildTools registration, recursion guard
 * (spawn_subagent + task_complete always stripped from sub-agent toolset),
 * nested run returns the sub-agent's text to the parent, and failures
 * resolve to an ERROR string rather than throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTools } from './index.js'
import {
    buildSubagentToolset,
    runSubagent,
    SUBAGENT_BLOCKED_TOOLS,
    SUBAGENT_DEFAULT_TOOLS,
} from './subagent.js'
import type { ExecutionContext } from '../types.js'

// Mock routeAndCall so runSubagent never hits a real provider.
const routeAndCallMock = vi.fn()
vi.mock('../providers/router-v2/index.js', () => ({
    routeAndCall: (...args: unknown[]) => routeAndCallMock(...args),
    RouterV2CallError: class RouterV2CallError extends Error {},
}))

function makeCtx(workDir: string): ExecutionContext {
    return {
        taskId: 'parent-task',
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

describe('DD-4: spawn_subagent tool', () => {
    let workDir: string
    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'plexo-subagent-'))
        routeAndCallMock.mockReset()
    })
    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true })
    })

    it('is present in buildTools output', () => {
        const ctx = makeCtx(workDir)
        const tools = buildTools(ctx, null) as Record<string, unknown>
        expect(tools).toHaveProperty('spawn_subagent')
    })

    it('returns an error string when no runner is wired (does not throw)', async () => {
        const ctx = makeCtx(workDir)
        const tools = buildTools(ctx, null) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>
        const out = await tools.spawn_subagent!.execute({ brief: 'do something' })
        expect(out).toMatch(/^ERROR: spawn_subagent is not wired/)
    })

    it('returns the sub-agent result text to the parent via the runner', async () => {
        const ctx = makeCtx(workDir)
        const parentTools = { read_file: {}, grep: {}, spawn_subagent: {}, task_complete: {} }
        routeAndCallMock.mockResolvedValue({ text: 'SUB-AGENT RESULT: 42' })
        const out = await runSubagent({
            ctx,
            settings: { primaryProvider: 'anthropic', fallbackChain: [], providers: { anthropic: { provider: 'anthropic' } } } as never,
            parentTools,
            input: { brief: 'compute the answer', maxSteps: 3 },
        })
        expect(out).toBe('SUB-AGENT RESULT: 42')
        expect(routeAndCallMock).toHaveBeenCalledTimes(1)
    })

    it('returns an ERROR string (does not throw) when the model call rejects', async () => {
        const ctx = makeCtx(workDir)
        const parentTools = { read_file: {} }
        routeAndCallMock.mockRejectedValue(new Error('upstream 500'))
        const out = await runSubagent({
            ctx,
            settings: { primaryProvider: 'anthropic', fallbackChain: [], providers: { anthropic: { provider: 'anthropic' } } } as never,
            parentTools,
            input: { brief: 'fail please' },
        })
        expect(out).toMatch(/^ERROR: sub-agent failed/)
        expect(out).toContain('upstream 500')
    })

    it('returns an ERROR string when the sub-agent produces empty output', async () => {
        const ctx = makeCtx(workDir)
        routeAndCallMock.mockResolvedValue({ text: '   ' })
        const out = await runSubagent({
            ctx,
            settings: { primaryProvider: 'anthropic', fallbackChain: [], providers: { anthropic: { provider: 'anthropic' } } } as never,
            parentTools: { read_file: {} },
            input: { brief: 'empty' },
        })
        expect(out).toMatch(/^ERROR: sub-agent produced no output/)
    })
})

describe('DD-4: recursion guard — sub-agent toolset', () => {
    it('default toolset is the read-only safe subset', () => {
        const parent = Object.fromEntries(
            [...SUBAGENT_DEFAULT_TOOLS, 'spawn_subagent', 'task_complete', 'shell', 'write_file'].map((n) => [n, {}]),
        )
        const sub = buildSubagentToolset(parent)
        expect(Object.keys(sub).sort()).toEqual([...SUBAGENT_DEFAULT_TOOLS].sort())
    })

    it('excludes spawn_subagent + task_complete even when explicitly whitelisted', () => {
        const parent = {
            read_file: {},
            write_file: {},
            shell: {},
            spawn_subagent: {},
            task_complete: {},
        }
        const sub = buildSubagentToolset(parent, ['read_file', 'write_file', 'spawn_subagent', 'task_complete'])
        expect(sub).toHaveProperty('read_file')
        expect(sub).toHaveProperty('write_file')
        expect(sub).not.toHaveProperty('spawn_subagent')
        expect(sub).not.toHaveProperty('task_complete')
    })

    it('SUBAGENT_BLOCKED_TOOLS contains spawn_subagent + task_complete', () => {
        expect(SUBAGENT_BLOCKED_TOOLS).toContain('spawn_subagent')
        expect(SUBAGENT_BLOCKED_TOOLS).toContain('task_complete')
    })

    it('drops whitelist names not present in parent toolset', () => {
        const parent = { read_file: {} }
        const sub = buildSubagentToolset(parent, ['read_file', 'shell'])
        expect(Object.keys(sub)).toEqual(['read_file'])
    })

    it('returns empty set (and runSubagent reports an error) when whitelist yields zero usable tools', () => {
        const parent = { spawn_subagent: {}, task_complete: {} }
        const sub = buildSubagentToolset(parent, ['spawn_subagent', 'task_complete'])
        expect(Object.keys(sub)).toHaveLength(0)
    })
})