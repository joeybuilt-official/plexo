// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * spawn_subagent — forked sub-agent dispatch (Claude-Code-style Task tool).
 *
 * A sub-agent is a NESTED agent loop: one `generateText` call with its own
 * scoped system prompt + a SUBSET of the parent's tools, bounded by
 * `stopWhen: stepCountIs(maxSteps)`. The sub-agent's final text is returned
 * to the parent model as the tool result.
 *
 * Recursion guard: `spawn_subagent` (and `task_complete`) are ALWAYS stripped
 * from the sub-agent's toolset, so a sub-agent cannot spawn further
 * sub-agents — max depth is mechanically 1. No depth counter needed.
 *
 * Event contract: the sub-agent's emitStepEvent is suppressed (not forwarded)
 * to avoid introducing new SSE event shapes on the parent's stream. The
 * sub-agent's default toolset is read-only, so no step.file_write /
 * step.shell_line events would fire anyway; if the parent whitelists a
 * write tool, the file is still written to disk — only the live SSE event
 * is skipped (the parent's next read_file / shell sees the result).
 */

import { generateText, stepCountIs } from 'ai'
import { routeAndCall } from '../providers/router-v2/index.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import type { ExecutionContext } from '../types.js'
import pino from 'pino'

/** Tools the sub-agent gets by default (read-only safe subset). */
export const SUBAGENT_DEFAULT_TOOLS: readonly string[] = [
    'read_file', 'grep', 'glob', 'web_search', 'web_read_page', 'web_fetch',
]

/**
 * Tools ALWAYS excluded from the sub-agent toolset even when the caller
 * whitelists them — the recursion guard + task-completion isolation.
 * `spawn_subagent` exclusion is what enforces max depth 1.
 */
export const SUBAGENT_BLOCKED_TOOLS: readonly string[] = [
    'spawn_subagent', 'task_complete',
]

/**
 * Tools ALWAYS denied to sub-agents — parent whitelist cannot override.
 * Enforces FS isolation: sub-agent cannot modify parent filesystem.
 */
export const SUBAGENT_DENIED_TOOLS: readonly string[] = [
    'write_file', 'edit_file', 'shell', 'task_complete', 'spawn_subagent',
]

const logger = pino({ name: 'executor:subagent' })

export const SUBAGENT_MAX_STEPS = 10
export const SUBAGENT_TIMEOUT_MS = 120_000

export interface SubagentInput {
    brief: string
    goal?: string
    /** Whitelist of parent tool names the sub-agent may use. */
    tools?: string[]
    /** Step ceiling for the nested loop. */
    maxSteps?: number
}

export interface SubagentRunner {
    (input: SubagentInput): Promise<string>
}

/**
 * Build the sub-agent's scoped toolset from the parent's full toolset.
 * - If `whitelist` is provided, keep exactly those names (minus blocked/denied).
 * - Otherwise keep {@link SUBAGENT_DEFAULT_TOOLS} (minus blocked/denied).
 * - Unknown / blocked / denied names are dropped; denied whitelist attempts log a warning.
 */
export function buildSubagentToolset(
    parentTools: Record<string, unknown>,
    whitelist?: string[],
): Record<string, unknown> {
    const base = whitelist && whitelist.length > 0 ? whitelist : SUBAGENT_DEFAULT_TOOLS
    const deniedInWhitelist = base.filter((n) => SUBAGENT_DENIED_TOOLS.includes(n))
    if (deniedInWhitelist.length > 0) {
        logger.warn({ denied: deniedInWhitelist }, 'Sub-agent whitelist contains denied tools — stripped')
    }
    const allowed = new Set<string>(
        base
            .filter((n) => !SUBAGENT_BLOCKED_TOOLS.includes(n))
            .filter((n) => !SUBAGENT_DENIED_TOOLS.includes(n)),
    )
    const out: Record<string, unknown> = {}
    for (const name of Object.keys(parentTools)) {
        if (allowed.has(name)) out[name] = parentTools[name]!
    }
    return out
}

/**
 * Run a single nested sub-agent loop. Returns the sub-agent's final text, or
 * an `ERROR: ...` string on failure/timeout — never throws to the parent.
 */
export async function runSubagent(args: {
    ctx: ExecutionContext
    settings: WorkspaceAISettings
    parentTools: Record<string, unknown>
    input: SubagentInput
}): Promise<string> {
    const { ctx, settings, parentTools, input } = args
    const maxSteps = input.maxSteps && input.maxSteps > 0 ? input.maxSteps : SUBAGENT_MAX_STEPS
    const subTaskId = `${ctx.taskId}-sub-${Date.now().toString(36)}`
    const workDir = (ctx.sprintWorkDir as string | undefined) ?? process.cwd()

    const subTools = buildSubagentToolset(parentTools, input.tools)
    if (Object.keys(subTools).length === 0) {
        return `ERROR: no tools available for sub-agent (whitelist=${JSON.stringify(input.tools ?? [])} yielded zero usable tools)`
    }

    const goalLine = input.goal ? `\nGoal: ${input.goal}` : ''
    const systemPrompt =
        `You are a focused sub-agent dispatched by a parent agent. ` +
        `Complete the brief below using the tools provided, then return your ` +
        `result as plain text. Do NOT call task_complete — it is not available. ` +
        `Work within the working directory: ${workDir}\n\n` +
        `Brief: ${input.brief}${goalLine}`

    // Sub-ctx: shares workdir/workspace/credential/signal; own taskId; events
    // suppressed (see module doc — avoids new SSE shapes on the parent stream).
    const subCtx: ExecutionContext = {
        ...ctx,
        taskId: subTaskId,
        emitStepEvent: undefined,
    }

    try {
        const result = await routeAndCall({
            workspaceId: ctx.workspaceId,
            taskId: subTaskId,
            taskType: 'codeGeneration',
            settings,
            doCall: async (model) => {
                return generateText({
                    model,
                    system: systemPrompt,
                    messages: [{ role: 'user', content: input.brief + (input.goal ? `\n\nGoal: ${input.goal}` : '') }],
                    tools: subTools,
                    stopWhen: stepCountIs(maxSteps),
                    abortSignal: AbortSignal.any([ctx.signal, AbortSignal.timeout(SUBAGENT_TIMEOUT_MS)]),
                } as never)
            },
        })
        const text = (result as { text?: string }).text ?? ''
        if (!text.trim()) {
            return `ERROR: sub-agent produced no output (task=${subTaskId})`
        }
        return text
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `ERROR: sub-agent failed (task=${subTaskId}): ${msg}`
    }
}

/**
 * Wire {@link ExecutionContext.runSubagent} so the `spawn_subagent` tool can
 * dispatch a nested run using the parent's resolved settings + full toolset.
 * Call AFTER the parent's `allTools` is assembled.
 */
export function wireSubagentRunner(
    ctx: ExecutionContext,
    settings: WorkspaceAISettings,
    parentTools: Record<string, unknown>,
): void {
    ctx.runSubagent = (input: SubagentInput) =>
        runSubagent({ ctx, settings, parentTools, input })
}