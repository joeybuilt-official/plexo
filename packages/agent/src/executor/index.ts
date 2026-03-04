import { generateText, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { db, sql } from '@plexo/db'
import { taskSteps } from '@plexo/db'
import { withFallback } from '../providers/registry.js'
import { SAFETY_LIMITS } from '../constants.js'
import { PlexoError } from '../errors.js'
import { loadConnectionTools } from '../connections/bridge.js'
import type { ExecutionContext, ExecutionPlan, ExecutionResult, StepResult } from '../types.js'
import type { WorkspaceAISettings } from '../providers/registry.js'

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

// ── Vercel AI SDK tool definitions (AI SDK v6 format) ────────────────────────
// Tool.inputSchema replaces "parameters" from earlier SDK versions.

function buildTools(ctx: ExecutionContext) {
    return {
        read_file: tool({
            description: 'Read the contents of a file at the given path.',
            inputSchema: z.object({
                path: z.string().describe('Absolute or repo-relative path to read'),
            }),
            execute: async (input) => dispatchTool('read_file', input as Record<string, unknown>, ctx),
        }),
        write_file: tool({
            description: 'Write content to a file. Creates the file if it does not exist.',
            inputSchema: z.object({
                path: z.string().describe('Path to write to'),
                content: z.string().describe('Full file content to write'),
            }),
            execute: async (input) => dispatchTool('write_file', input as Record<string, unknown>, ctx),
        }),
        shell: tool({
            description: 'Run a shell command. Avoid destructive operations; prefer reads first.',
            inputSchema: z.object({
                command: z.string().describe('Shell command to execute'),
                cwd: z.string().optional().describe('Working directory (optional)'),
            }),
            execute: async (input) => dispatchTool('shell', input as Record<string, unknown>, ctx),
        }),
        task_complete: tool({
            description: 'Signal that all steps are done and provide a summary of the outcome.',
            inputSchema: z.object({
                summary: z.string().describe('What was accomplished'),
                qualityScore: z.number().min(0).max(1).describe('0.0–1.0 self-assessment score'),
            }),
            execute: async (input) =>
                dispatchTool('task_complete', input as Record<string, unknown>, ctx),
        }),
    }
}

// ── Default workspace AI settings (legacy / no-config mode) ─────────────────

function defaultSettings(): WorkspaceAISettings {
    return {
        primaryProvider: 'anthropic',
        fallbackChain: [],
        providers: {
            anthropic: { provider: 'anthropic' },
        },
    }
}

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeTask(
    ctx: ExecutionContext,
    plan: ExecutionPlan,
    aiSettings?: WorkspaceAISettings,
): Promise<ExecutionResult> {
    const settings = aiSettings ?? defaultSettings()
    const startTime = Date.now()
    const stepResults: StepResult[] = []

    let totalTokensIn = 0
    let totalTokensOut = 0
    let totalCost = 0
    let finalSummary = ''
    let finalQuality = 0.5

    // Load workspace personality settings (non-fatal)
    let agentName = 'Plexo'
    let personaPrefix = ''
    let systemPromptExtra = ''
    try {
        const { workspaces } = await import('@plexo/db')
        const { db: dbInst, eq: eqFn } = await import('@plexo/db')
        const [ws] = await dbInst.select({ settings: workspaces.settings }).from(workspaces)
            .where(eqFn(workspaces.id, ctx.workspaceId)).limit(1)
        if (ws?.settings) {
            const s = ws.settings as Record<string, unknown>
            if (typeof s.agentName === 'string' && s.agentName) agentName = s.agentName
            if (typeof s.agentPersona === 'string' && s.agentPersona) personaPrefix = s.agentPersona + '\n\n'
            if (typeof s.systemPromptExtra === 'string' && s.systemPromptExtra) systemPromptExtra = '\n\n' + s.systemPromptExtra
        }
    } catch { /* non-fatal */ }

    const systemPrompt = `${personaPrefix}You are ${agentName}, an autonomous AI agent executing a task.

Task goal: ${plan.goal}

You have ${plan.steps.length} planned steps. Work through them carefully.
- Use tools to make progress. Read before writing.
- When you have completed all steps, call task_complete.
- Be conservative. If something seems wrong, stop and report it.
- NEVER output credentials, secrets, or tokens in any tool call or message.${systemPromptExtra}`

    const planSummary = plan.steps
        .map((s) => `Step ${s.stepNumber}: ${s.description}`)
        .join('\n')

    const userMessage = `Execute this plan:\n\n${planSummary}\n\nBegin with step 1.`

    if (ctx.signal.aborted) {
        throw new PlexoError('Task cancelled', 'TASK_CANCELLED', 'user', 499)
    }

    const stepStart = Date.now()

    // Load connection-backed tools for this workspace (non-fatal if fails)
    const connectionTools = await loadConnectionTools(ctx.workspaceId)
    const allTools = { ...buildTools(ctx), ...connectionTools }

    const genResult = await withFallback(settings, 'codeGeneration', async (model) => {
        return generateText({
            model,
            system: systemPrompt,
            messages: [{ role: 'user', content: userMessage }],
            tools: allTools,
            stopWhen: stepCountIs(SAFETY_LIMITS.maxConsecutiveToolCalls),
            abortSignal: ctx.signal,
        })
    })

    // AI SDK v6: usage.inputTokens / usage.outputTokens
    const tokensIn = genResult.usage.inputTokens ?? 0
    const tokensOut = genResult.usage.outputTokens ?? 0

    // Estimate cost — rough claude-sonnet rates
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

    // Extract tool call records from steps
    // AI SDK v6: toolCalls[].input (not .args), toolResults[].output (not .result)
    const toolCallRecords: StepResult['toolCalls'] = []
    for (const step of genResult.steps) {
        for (const tc of step.toolCalls) {
            // TypedToolCall has .input in v6; DynamicToolCall also has .input
            const input = (tc as { input: unknown }).input as Record<string, unknown>
            const toolResult = step.toolResults.find((r) => r.toolCallId === tc.toolCallId)
            // TypedToolResult / DynamicToolResult have .output in v6
            const output = toolResult
                ? String((toolResult as { output: unknown }).output ?? '')
                : ''

            toolCallRecords.push({
                tool: tc.toolName,
                input,
                output,
            })

            if (tc.toolName === 'task_complete') {
                try {
                    const parsed = JSON.parse(output) as { summary: string; qualityScore: number }
                    finalSummary = parsed.summary
                    finalQuality = Math.min(1, Math.max(0, parsed.qualityScore))
                } catch {
                    finalSummary = output
                }
            }
        }
    }

    if (!finalSummary) {
        finalSummary = genResult.text || 'Agent stopped without calling task_complete'
    }

    const stepDurationMs = Date.now() - stepStart

    // Persist step record to DB
    await db.insert(taskSteps).values({
        taskId: ctx.taskId,
        stepNumber: 1,
        model: 'vercel-ai-sdk',
        tokensIn,
        tokensOut,
        toolCalls: toolCallRecords,
        outcome: finalSummary ? 'complete' : 'running',
    })

    stepResults.push({
        stepNumber: 1,
        ok: true,
        output: finalSummary,
        toolCalls: toolCallRecords,
        tokensIn,
        tokensOut,
        costUsd,
        durationMs: stepDurationMs,
    })

    // Hard wall clock check
    if (Date.now() - startTime > SAFETY_LIMITS.maxWallClockMs) {
        throw new PlexoError('Wall clock limit exceeded', 'WALL_CLOCK_EXCEEDED', 'system', 500)
    }

    const executionResult: ExecutionResult = {
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
        const day = now.getDay()
        const weekStart = new Date(now)
        weekStart.setDate(now.getDate() - ((day + 6) % 7))
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
            .filter(Boolean),
    )
    const memOutcome: 'success' | 'partial' | 'failure' = executionResult.ok
        ? finalQuality >= 0.7
            ? 'success'
            : 'partial'
        : 'failure'

    Promise.all([
        import('../memory/store.js').then(({ recordTaskMemory }) =>
            recordTaskMemory({
                workspaceId: ctx.workspaceId,
                taskId: ctx.taskId,
                description: ctx.taskId,
                outcome: memOutcome,
                toolsUsed,
                qualityScore: finalQuality,
                durationMs: executionResult.totalDurationMs,
            }),
        ),
        import('../memory/preferences.js').then(({ inferFromTaskOutcome }) =>
            inferFromTaskOutcome({
                workspaceId: ctx.workspaceId,
                toolsUsed,
                filesWritten,
                qualityScore: finalQuality,
                outcome: memOutcome,
            }),
        ),
    ]).catch(() => { /* memory errors are never fatal */ })

    return executionResult
}
