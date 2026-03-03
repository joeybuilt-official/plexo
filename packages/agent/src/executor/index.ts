import Anthropic from '@anthropic-ai/sdk'
import { db, sql } from '@plexo/db'
import { taskSteps, apiCostTracking } from '@plexo/db'
import { buildAnthropicClient } from '../ai/client.js'
import { MODEL_ROUTING, SAFETY_LIMITS } from '../constants.js'
import { PlexoError } from '../errors.js'
import type { ExecutionContext, ExecutionPlan, ExecutionResult, StepResult } from '../types.js'

// ── Built-in tools exposed to the agent ──────────────────────────────────────
// Phase 2: read_file, write_file, shell (sandboxed). Full tool set in Phase 3.

const TOOLS: Anthropic.Messages.Tool[] = [
    {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        input_schema: {
            type: 'object' as const,
            properties: {
                path: { type: 'string', description: 'Absolute or repo-relative path to read' },
            },
            required: ['path'],
        },
    },
    {
        name: 'write_file',
        description: 'Write content to a file. Creates the file if it does not exist.',
        input_schema: {
            type: 'object' as const,
            properties: {
                path: { type: 'string', description: 'Path to write to' },
                content: { type: 'string', description: 'Full file content to write' },
            },
            required: ['path', 'content'],
        },
    },
    {
        name: 'shell',
        description: 'Run a shell command. Avoid destructive operations; prefer reads first.',
        input_schema: {
            type: 'object' as const,
            properties: {
                command: { type: 'string', description: 'Shell command to execute' },
                cwd: { type: 'string', description: 'Working directory (optional)' },
            },
            required: ['command'],
        },
    },
    {
        name: 'task_complete',
        description: 'Signal that all steps are done and provide a summary of the outcome.',
        input_schema: {
            type: 'object' as const,
            properties: {
                summary: { type: 'string', description: 'What was accomplished' },
                qualityScore: { type: 'number', description: '0.0–1.0 self-assessment score' },
            },
            required: ['summary', 'qualityScore'],
        },
    },
]

// ── Tool dispatcher — Phase 2 stubs ──────────────────────────────────────────
// Each tool runs locally for now. Phase 3 moves to sandboxed worker containers.

async function dispatchTool(
    name: string,
    input: Record<string, unknown>,
    _ctx: ExecutionContext,
): Promise<string> {
    const { execSync } = await import('node:child_process')
    const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { dirname } = await import('node:path')

    switch (name) {
        case 'read_file': {
            try {
                return readFileSync(input.path as string, 'utf8')
            } catch (e) {
                return `ERROR: ${(e as Error).message}`
            }
        }

        case 'write_file': {
            try {
                const p = input.path as string
                mkdirSync(dirname(p), { recursive: true })
                writeFileSync(p, input.content as string, 'utf8')
                return `OK: wrote ${(input.content as string).length} bytes to ${p}`
            } catch (e) {
                return `ERROR: ${(e as Error).message}`
            }
        }

        case 'shell': {
            try {
                const out = execSync(input.command as string, {
                    cwd: (input.cwd as string) ?? process.cwd(),
                    timeout: 30_000,
                    maxBuffer: 1024 * 1024,
                    encoding: 'utf8',
                })
                return out.trim()
            } catch (e) {
                const err = e as { stdout?: string; stderr?: string; message: string }
                return `ERROR: ${err.stderr ?? err.message}`
            }
        }

        case 'task_complete': {
            return JSON.stringify({ done: true, summary: input.summary, qualityScore: input.qualityScore })
        }

        default:
            return `ERROR: Unknown tool "${name}"`
    }
}

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeTask(
    ctx: ExecutionContext,
    plan: ExecutionPlan,
): Promise<ExecutionResult> {
    const client = await buildAnthropicClient(ctx.credential)
    const startTime = Date.now()
    const stepResults: StepResult[] = []

    let totalTokensIn = 0
    let totalTokensOut = 0
    let totalCost = 0
    let finalSummary = ''
    let finalQuality = 0.5

    const systemPrompt = `You are Plexo, an autonomous AI agent executing a task.

Task goal: ${plan.goal}

You have ${plan.steps.length} planned steps. Work through them carefully.
- Use tools to make progress. Read before writing.
- When you have completed all steps, call task_complete.
- Be conservative. If something seems wrong, stop and report it.
- NEVER output credentials, secrets, or tokens in any tool call or message.`

    // Build initial message from plan
    const planSummary = plan.steps
        .map((s) => `Step ${s.stepNumber}: ${s.description}`)
        .join('\n')

    const messages: Anthropic.Messages.MessageParam[] = [
        {
            role: 'user',
            content: `Execute this plan:\n\n${planSummary}\n\nBegin with step 1.`,
        },
    ]

    let consecutiveToolCalls = 0
    let done = false
    let stepNumber = 0

    while (!done) {
        if (ctx.signal.aborted) {
            throw new PlexoError('Task cancelled', 'TASK_CANCELLED', 'user', 499)
        }

        stepNumber++
        const stepStart = Date.now()
        const toolCallsThisStep: StepResult['toolCalls'] = []

        const response = await client.messages.create({
            model: MODEL_ROUTING.codeGeneration,
            max_tokens: 4096,
            system: systemPrompt,
            tools: TOOLS,
            messages,
        })

        const tokensIn = response.usage.input_tokens
        const tokensOut = response.usage.output_tokens

        // Estimate cost — claude-sonnet-4-5 rates
        const costUsd = (tokensIn / 1_000_000) * 3 + (tokensOut / 1_000_000) * 15
        totalTokensIn += tokensIn
        totalTokensOut += tokensOut
        totalCost += costUsd

        // Check cost ceiling
        if (totalCost > (Number(process.env.API_COST_CEILING_USD) || 10)) {
            throw new PlexoError(
                `Cost ceiling reached: $${totalCost.toFixed(4)}`,
                'COST_CEILING_REACHED',
                'system',
                429,
            )
        }

        // Process response content
        const assistantContent: Anthropic.Messages.ContentBlockParam[] = []
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

        for (const block of response.content) {
            assistantContent.push(block as Anthropic.Messages.ContentBlockParam)

            if (block.type === 'tool_use') {
                consecutiveToolCalls++
                if (consecutiveToolCalls > SAFETY_LIMITS.maxConsecutiveToolCalls) {
                    throw new PlexoError(
                        `Exceeded max consecutive tool calls (${SAFETY_LIMITS.maxConsecutiveToolCalls})`,
                        'TOO_MANY_TOOL_CALLS',
                        'system',
                        500,
                    )
                }

                const toolInput = block.input as Record<string, unknown>
                const toolOutput = await dispatchTool(block.name, toolInput, ctx)

                if (block.name === 'task_complete') {
                    try {
                        const parsed = JSON.parse(toolOutput) as { summary: string; qualityScore: number }
                        finalSummary = parsed.summary
                        finalQuality = Math.min(1, Math.max(0, parsed.qualityScore))
                    } catch {
                        finalSummary = toolOutput
                    }
                    done = true
                }

                toolCallsThisStep.push({
                    tool: block.name,
                    input: toolInput,
                    output: toolOutput,
                })

                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: toolOutput,
                })
            } else {
                consecutiveToolCalls = 0
            }
        }

        // Add assistant turn + tool results to message history
        messages.push({ role: 'assistant', content: assistantContent })
        if (toolResults.length > 0) {
            messages.push({ role: 'user', content: toolResults })
        }

        const stepDurationMs = Date.now() - stepStart

        // Persist step record to DB
        await db.insert(taskSteps).values({
            taskId: ctx.taskId,
            stepNumber,
            model: MODEL_ROUTING.codeGeneration,
            tokensIn,
            tokensOut,
            toolCalls: toolCallsThisStep,
            outcome: done ? 'complete' : 'running',
        })

        stepResults.push({
            stepNumber,
            ok: true,
            output: finalSummary || '',
            toolCalls: toolCallsThisStep,
            tokensIn,
            tokensOut,
            costUsd,
            durationMs: stepDurationMs,
        })

        // Stop if model says stop_reason is end_turn with no tool use
        if (response.stop_reason === 'end_turn' && toolCallsThisStep.length === 0 && !done) {
            finalSummary = finalSummary || 'Agent stopped without calling task_complete'
            done = true
        }

        // Hard wall clock limit
        if (Date.now() - startTime > SAFETY_LIMITS.maxWallClockMs) {
            throw new PlexoError('Wall clock limit exceeded', 'WALL_CLOCK_EXCEEDED', 'system', 500)
        }
    }

    const result: ExecutionResult = {
        taskId: ctx.taskId,
        ok: true,
        steps: stepResults,
        outcomeSummary: finalSummary,
        qualityScore: finalQuality,
        totalTokensIn,
        totalTokensOut,
        totalCostUsd: totalCost,
        totalDurationMs: Date.now() - startTime,
    }

    // Write cost to api_cost_tracking (weekly accumulation)
    try {
        const now = new Date()
        const day = now.getDay() // 0=Sun, 1=Mon...
        const weekStart = new Date(now)
        weekStart.setDate(now.getDate() - ((day + 6) % 7)) // ISO week: Monday
        weekStart.setUTCHours(0, 0, 0, 0)
        const weekStartStr = weekStart.toISOString().slice(0, 10)

        const ceiling = Number(process.env.API_COST_CEILING_USD) || 10

        await db.execute(sql`
            INSERT INTO api_cost_tracking
                (id, workspace_id, week_start, cost_usd, ceiling_usd, alerted_80)
            VALUES
                (gen_random_uuid(), ${ctx.workspaceId}, ${weekStartStr}, ${totalCost}, ${ceiling}, false)
            ON CONFLICT (workspace_id, week_start) DO UPDATE SET
                cost_usd = api_cost_tracking.cost_usd + EXCLUDED.cost_usd,
                alerted_80 = CASE
                    WHEN (api_cost_tracking.cost_usd + EXCLUDED.cost_usd) >= (api_cost_tracking.ceiling_usd * 0.8)
                    THEN true
                    ELSE api_cost_tracking.alerted_80
                END
        `)
    } catch (_costErr) {
        // Non-fatal — don't fail the task if cost tracking write fails
    }

    // Record task outcome to semantic memory + infer preferences (non-blocking)
    const toolsUsed = stepResults.flatMap((s) => s.toolCalls.map((t) => t.tool))
    const filesWritten = stepResults.flatMap((s) =>
        s.toolCalls
            .filter((t) => t.tool === 'write_file' || t.tool === 'create_file')
            .map((t) => String((t.input as Record<string, unknown>)?.path ?? ''))
            .filter(Boolean)
    )
    const memOutcome: 'success' | 'partial' | 'failure' = result.ok
        ? (finalQuality >= 0.7 ? 'success' : 'partial')
        : 'failure'

    Promise.all([
        import('../memory/store.js').then(({ recordTaskMemory }) =>
            recordTaskMemory({
                workspaceId: ctx.workspaceId,
                taskId: ctx.taskId,
                description: ctx.taskId, // executor doesn't receive description; memory content includes tool trace
                outcome: memOutcome,
                toolsUsed,
                qualityScore: finalQuality,
                durationMs: result.totalDurationMs,
            })
        ),
        import('../memory/preferences.js').then(({ inferFromTaskOutcome }) =>
            inferFromTaskOutcome({
                workspaceId: ctx.workspaceId,
                toolsUsed,
                filesWritten,
                qualityScore: finalQuality,
                outcome: memOutcome,
            })
        ),
    ]).catch(() => { /* memory errors are never fatal */ })

    return result
}
