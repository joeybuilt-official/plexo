// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MockLLM: a scripted LanguageModel for deterministic agent tests.
 * Accepts a StepScript[] and returns the next scripted response on each doGenerate call.
 * No network calls, no randomness — fully reproducible.
 */

export interface StepScript {
    toolCalls?: Array<{
        toolName: string
        args: Record<string, unknown>
    }>
    text?: string
    isTerminal?: boolean
}

interface MockGenerateResult {
    text: string
    usage: { inputTokens: number; outputTokens: number }
    response: { messages: unknown[] }
    steps: Array<{
        toolCalls: Array<{
            toolName: string
            toolCallId: string
            input: Record<string, unknown>
        }>
        toolResults: Array<{
            toolCallId: string
            output: string
        }>
    }>
}

/**
 * Build a scripted mock response from a StepScript entry.
 */
function buildMockResponse(script: StepScript): MockGenerateResult {
    const toolCalls = (script.toolCalls ?? []).map((tc, i) => ({
        toolName: tc.toolName,
        toolCallId: `mock-tc-${i}-${Date.now()}`,
        input: tc.args,
    }))

    const toolResults = toolCalls.map(tc => ({
        toolCallId: tc.toolCallId,
        output: tc.toolName === 'task_complete'
            ? JSON.stringify({ done: true, summary: (tc.input as Record<string, unknown>).summary ?? 'Mock complete', qualityScore: 0.9 })
            : 'mock-result',
    }))

    const steps = toolCalls.length > 0
        ? [{ toolCalls, toolResults }]
        : [{ toolCalls: [], toolResults: [] }]

    const assistantMessage: Record<string, unknown> = {
        role: 'assistant',
        content: script.text ?? '',
    }
    if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls.map(tc => ({
            id: tc.toolCallId,
            type: 'function',
            function: { name: tc.toolName, arguments: JSON.stringify(tc.input) },
        }))
    }

    return {
        text: script.text ?? '',
        usage: { inputTokens: 100, outputTokens: 50 },
        response: { messages: [assistantMessage] },
        steps,
    }
}

/**
 * Create a mock LanguageModel that replays a scripted sequence.
 * Compatible with Vercel AI SDK v6's LanguageModel interface (subset).
 */
export function createMockLLM(script: StepScript[]): {
    specificationVersion: string
    provider: string
    modelId: string
    doGenerate: () => Promise<MockGenerateResult>
} {
    let i = 0
    return {
        specificationVersion: 'v1',
        provider: 'mock',
        modelId: 'mock-llm',
        async doGenerate() {
            const step = script[i++] ?? { isTerminal: true, text: 'No more scripted steps' }
            return buildMockResponse(step)
        },
    }
}
