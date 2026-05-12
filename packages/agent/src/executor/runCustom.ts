// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Custom agent loop — caller provides systemPrompt + tools; Plexo runs the
 * Vercel AI SDK multi-step loop, dispatching tool calls back to caller-provided
 * HTTP endpoints (signed with a per-run JWT issued by the API layer).
 *
 * Used by /api/v1/agents/run-custom (EP1 per FF ADR 0035).
 * Optionally exposes Plexo memory as an LLM-callable tool (EP2).
 */

import { generateText, tool, stepCountIs, jsonSchema, type Tool } from 'ai'
import pino from 'pino'
import { resolveModel, type WorkspaceAISettings } from '../providers/registry.js'
import { searchMemory } from '../memory/store.js'

const logger = pino({ name: 'executor/runCustom' })

export interface CustomToolSpec {
    name: string
    description: string
    inputSchema: Record<string, unknown>
    callbackUrl: string
}

export interface ExecuteCustomTaskOpts {
    workspaceId: string
    runId: string
    runJwt: string
    systemPrompt: string
    tools: CustomToolSpec[]
    input: string
    maxSteps?: number
    enableMemoryTool?: boolean
    aiSettings: WorkspaceAISettings
    model?: string
}

export interface CustomTaskStep {
    tool?: string
    input?: Record<string, unknown>
    output?: unknown
    error?: string
}

export interface CustomTaskResult {
    runId: string
    output: string
    steps: CustomTaskStep[]
    truncated: boolean
}

const CALLBACK_TIMEOUT_MS = 30_000
const TOOL_NAME_RE = /^[a-zA-Z0-9_]{1,64}$/

export async function executeCustomTask(opts: ExecuteCustomTaskOpts): Promise<CustomTaskResult> {
    const maxSteps = opts.maxSteps ?? 12
    const steps: CustomTaskStep[] = []

    for (const t of opts.tools) {
        if (!TOOL_NAME_RE.test(t.name)) {
            throw new Error(`Invalid tool name "${t.name}": must match ${TOOL_NAME_RE}`)
        }
    }
    if (opts.enableMemoryTool && opts.tools.some(t => t.name === 'read_memory')) {
        throw new Error('Tool name "read_memory" is reserved when enableMemoryTool is true')
    }

    const aiTools: Record<string, Tool> = {}

    for (const spec of opts.tools) {
        aiTools[spec.name] = tool({
            description: spec.description,
            inputSchema: jsonSchema(spec.inputSchema),
            execute: async (input: unknown) => {
                const stepRec: CustomTaskStep = {
                    tool: spec.name,
                    input: input as Record<string, unknown>,
                }
                try {
                    const res = await fetch(spec.callbackUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${opts.runJwt}`,
                        },
                        body: JSON.stringify({
                            runId: opts.runId,
                            toolName: spec.name,
                            input,
                        }),
                        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
                    })
                    if (!res.ok) {
                        const text = await res.text().catch(() => '')
                        const err = `callback ${spec.name} → HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`
                        stepRec.error = err
                        steps.push(stepRec)
                        return err
                    }
                    const data = (await res.json().catch(() => ({}))) as {
                        output?: unknown
                        error?: string
                    }
                    if (data.error) {
                        stepRec.error = data.error
                        steps.push(stepRec)
                        return `error: ${data.error}`
                    }
                    stepRec.output = data.output
                    steps.push(stepRec)
                    return typeof data.output === 'string'
                        ? data.output
                        : JSON.stringify(data.output ?? null)
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    stepRec.error = msg
                    steps.push(stepRec)
                    logger.warn({ tool: spec.name, runId: opts.runId, err: msg }, 'tool callback failed')
                    return `error: ${msg}`
                }
            },
        })
    }

    if (opts.enableMemoryTool) {
        aiTools.read_memory = tool({
            description:
                'Search prior memory stored about this workspace by natural-language query. ' +
                'Returns relevant facts, patterns, and notes the agent has stored previously.',
            inputSchema: jsonSchema({
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Natural-language query' },
                    limit: { type: 'number', description: 'Max results (default 10)' },
                    type: {
                        type: 'string',
                        description: 'Optional memory type filter (e.g. "fact", "pattern", "note")',
                    },
                },
                required: ['query'],
                additionalProperties: false,
            }),
            execute: async (input: unknown) => {
                const args = input as { query: string; limit?: number; type?: string }
                const stepRec: CustomTaskStep = { tool: 'read_memory', input: args }
                try {
                    const results = await searchMemory({
                        workspaceId: opts.workspaceId,
                        query: args.query,
                        limit: args.limit ?? 10,
                        type: args.type as Parameters<typeof searchMemory>[0]['type'],
                    })
                    stepRec.output = results
                    steps.push(stepRec)
                    return JSON.stringify(results)
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    stepRec.error = msg
                    steps.push(stepRec)
                    return `error: ${msg}`
                }
            },
        })
    }

    const { model } = await resolveModel('conversation', opts.aiSettings, opts.workspaceId)

    const result = await generateText({
        model,
        system: opts.systemPrompt,
        prompt: opts.input,
        tools: aiTools,
        stopWhen: stepCountIs(maxSteps),
    })

    const truncated = (result.steps?.length ?? 0) >= maxSteps && !result.finishReason

    return {
        runId: opts.runId,
        output: result.text ?? '',
        steps,
        truncated,
    }
}
