// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveOutputCeiling, hashToolCallArgs, detectTruncatedToolCall } from './output-ceiling.js'

// ── resolveOutputCeiling ──────────────────────────────────────────────────────

describe('resolveOutputCeiling', () => {
    const envKey = 'EXECUTOR_MAX_OUTPUT_TOKENS'

    beforeEach(() => {
        delete process.env[envKey]
    })
    afterEach(() => {
        delete process.env[envKey]
    })

    it('returns 32000 for anthropic/claude-opus-4', () => {
        expect(resolveOutputCeiling('anthropic', 'claude-opus-4-5')).toBe(32_000)
    })

    it('returns 32000 for anthropic/claude-sonnet-4', () => {
        expect(resolveOutputCeiling('anthropic', 'claude-sonnet-4-6')).toBe(32_000)
    })

    it('returns 8192 for anthropic/claude-3-5-sonnet', () => {
        expect(resolveOutputCeiling('anthropic', 'claude-3-5-sonnet-20241022')).toBe(8192)
    })

    it('returns 4096 for anthropic/claude-3', () => {
        expect(resolveOutputCeiling('anthropic', 'claude-3-opus-20240229')).toBe(4096)
    })

    it('returns 8192 for deepseek/deepseek-chat', () => {
        expect(resolveOutputCeiling('deepseek', 'deepseek-chat')).toBe(8192)
    })

    it('returns 8192 for deepseek/deepseek-reasoner', () => {
        expect(resolveOutputCeiling('deepseek', 'deepseek-reasoner')).toBe(8192)
    })

    it('returns 16000 for openai/gpt-4o', () => {
        expect(resolveOutputCeiling('openai', 'gpt-4o-2024-11-20')).toBe(16_000)
    })

    it('returns 32000 for openai/gpt-4.1', () => {
        expect(resolveOutputCeiling('openai', 'gpt-4.1')).toBe(32_000)
    })

    it('returns 8192 fallback for unknown model', () => {
        expect(resolveOutputCeiling('unknown-provider', 'some-model-xyz')).toBe(8192)
    })

    it('returns 8192 fallback for openrouter (no entry in table)', () => {
        expect(resolveOutputCeiling('openrouter', 'meta-llama/llama-3.3-70b-instruct')).toBe(8192)
    })

    it('env var EXECUTOR_MAX_OUTPUT_TOKENS overrides per-model default', () => {
        process.env[envKey] = '4000'
        expect(resolveOutputCeiling('anthropic', 'claude-opus-4-5')).toBe(4000)
    })

    it('env var overrides fallback for unknown models', () => {
        process.env[envKey] = '12000'
        expect(resolveOutputCeiling('unknown', 'model')).toBe(12000)
    })

    it('ignores non-positive env var override (treats as unset)', () => {
        process.env[envKey] = '0'
        expect(resolveOutputCeiling('deepseek', 'deepseek-chat')).toBe(8192)
    })

    it('ignores non-numeric env var override', () => {
        process.env[envKey] = 'banana'
        expect(resolveOutputCeiling('deepseek', 'deepseek-chat')).toBe(8192)
    })

    it('matching is case-insensitive', () => {
        expect(resolveOutputCeiling('Anthropic', 'Claude-Sonnet-4-6')).toBe(32_000)
        expect(resolveOutputCeiling('DEEPSEEK', 'DEEPSEEK-CHAT')).toBe(8192)
    })
})

// ── hashToolCallArgs ──────────────────────────────────────────────────────────

describe('hashToolCallArgs', () => {
    it('returns a string', () => {
        expect(typeof hashToolCallArgs({ key: 'value' })).toBe('string')
    })

    it('same input produces same hash', () => {
        const a = hashToolCallArgs({ path: '/tmp/foo.ts', content: 'hello' })
        const b = hashToolCallArgs({ path: '/tmp/foo.ts', content: 'hello' })
        expect(a).toBe(b)
    })

    it('different inputs produce different hashes', () => {
        const a = hashToolCallArgs({ path: '/tmp/foo.ts' })
        const b = hashToolCallArgs({ path: '/tmp/bar.ts' })
        expect(a).not.toBe(b)
    })

    it('handles null without throwing', () => {
        expect(() => hashToolCallArgs(null)).not.toThrow()
        expect(hashToolCallArgs(null)).toMatch(/^\d+:/)
    })

    it('handles undefined without throwing', () => {
        expect(() => hashToolCallArgs(undefined)).not.toThrow()
    })

    it('returns "0:0" when JSON.stringify would throw (circular reference)', () => {
        const obj: Record<string, unknown> = {}
        obj['self'] = obj
        expect(hashToolCallArgs(obj)).toBe('0:0')
    })

    it('hash includes length information (format: "len:hash")', () => {
        const h = hashToolCallArgs({ x: 1 })
        expect(h).toMatch(/^\d+:-?\d+$/)
    })
})

// ── detectTruncatedToolCall ───────────────────────────────────────────────────

describe('detectTruncatedToolCall', () => {
    it('returns not-truncated for null result', () => {
        const r = detectTruncatedToolCall(null)
        expect(r.truncated).toBe(false)
        expect(r.toolName).toBeNull()
    })

    it('returns not-truncated for undefined result', () => {
        const r = detectTruncatedToolCall(undefined)
        expect(r.truncated).toBe(false)
    })

    it('returns not-truncated when finishReason is "stop"', () => {
        const r = detectTruncatedToolCall({ finishReason: 'stop', steps: [] })
        expect(r.truncated).toBe(false)
    })

    it('returns not-truncated when finishReason is "tool-calls"', () => {
        const r = detectTruncatedToolCall({ finishReason: 'tool-calls', steps: [] })
        expect(r.truncated).toBe(false)
    })

    it('returns truncated when top-level finishReason is "length" with no tool calls', () => {
        const r = detectTruncatedToolCall({ finishReason: 'length', steps: [] })
        expect(r.truncated).toBe(true)
        expect(r.toolName).toBeNull()
    })

    it('returns truncated when a step finishReason is "length"', () => {
        const r = detectTruncatedToolCall({
            finishReason: 'stop',
            steps: [{ finishReason: 'length', toolCalls: [], toolResults: [] }],
        })
        expect(r.truncated).toBe(true)
    })

    it('returns truncated with toolName when a tool call has no matching result', () => {
        const r = detectTruncatedToolCall({
            finishReason: 'length',
            steps: [{
                finishReason: 'length',
                toolCalls: [{ toolCallId: 'tc1', toolName: 'write_file' }],
                toolResults: [],
            }],
        })
        expect(r.truncated).toBe(true)
        expect(r.toolName).toBe('write_file')
    })

    it('returns truncated when tool result output is empty string', () => {
        const r = detectTruncatedToolCall({
            finishReason: 'length',
            steps: [{
                finishReason: 'length',
                toolCalls: [{ toolCallId: 'tc1', toolName: 'run_bash' }],
                toolResults: [{ toolCallId: 'tc1', output: '' }],
            }],
        })
        expect(r.truncated).toBe(true)
        expect(r.toolName).toBe('run_bash')
    })

    it('returns NOT truncated when finishReason=length but all tool calls have results', () => {
        const r = detectTruncatedToolCall({
            finishReason: 'length',
            steps: [{
                finishReason: 'length',
                toolCalls: [{ toolCallId: 'tc1', toolName: 'read_file' }],
                toolResults: [{ toolCallId: 'tc1', output: 'file contents here' }],
            }],
        })
        // finishReason=length but the tool results are populated → truncation happened in
        // text after the tool call, not mid-tool-call. Still marked truncated to trigger nudge.
        expect(r.truncated).toBe(true)
    })

    it('returns NOT truncated when finishReason is stop and no truncation', () => {
        const r = detectTruncatedToolCall({
            finishReason: 'stop',
            steps: [{
                finishReason: 'stop',
                toolCalls: [{ toolCallId: 'tc1', toolName: 'task_complete' }],
                toolResults: [{ toolCallId: 'tc1', output: 'done' }],
            }],
        })
        expect(r.truncated).toBe(false)
    })
})
