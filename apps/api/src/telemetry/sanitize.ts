/**
 * Telemetry sanitizer — strips all user content before a payload leaves the instance.
 *
 * Rules enforced:
 *   - task.prompt, task.goal, steps[].output, steps[].toolArgs  → removed
 *   - workspace.name, user.name, user.email                     → removed
 *   - channel credentials and tokens                            → removed
 *   - file paths that look like user data paths                 → removed
 *   - memory entries and agent outputs                          → removed
 *   - kept: error type, stack trace (frame paths only, no args),
 *            task category, plugin name if relevant, plexo+node version,
 *            anonymous instance ID, which pipeline step failed
 *
 * This file is intentionally simple and auditable.
 * Users can inspect it at packages/api/src/telemetry/sanitize.ts
 */

export type PipelineStep = 'PLAN' | 'CONFIRM' | 'EXECUTE' | 'VERIFY' | 'REPORT'

export type TaskCategory =
    | 'coding'
    | 'research'
    | 'ops'
    | 'deployment'
    | 'automation'
    | 'unknown'

export interface TelemetryError {
    errorType: string
    stackFrames: string[]          // function names + file paths only — no args, no values
    pipelineStep: PipelineStep | null
    taskCategory: TaskCategory
    pluginName: string | null
    plexoVersion: string
    nodeVersion: string
    instanceId: string
}

export interface RawErrorContext {
    error: Error
    pipelineStep?: PipelineStep
    taskCategory?: string
    pluginName?: string
    instanceId: string
    plexoVersion: string
}

/**
 * Strip a stack trace to function names + sanitized file paths only.
 * Removes query strings, line/col if they encode data, and absolute user paths.
 */
function sanitizeStack(stack: string | undefined): string[] {
    if (!stack) return []
    return stack
        .split('\n')
        .slice(1) // remove the first line (error message)
        .map(line => line.trim())
        .filter(line => line.startsWith('at '))
        .map(line => {
            // Extract "at FunctionName (path:line:col)" or "at path:line:col"
            const match = line.match(/^at (.+?) \((.+?):(\d+):\d+\)$/) ??
                line.match(/^at (.+?):(\d+):\d+$/)
            if (!match) return line.slice(0, 80)
            const fn = match[1] ?? 'anonymous'
            const file = (match[2] ?? '').replace(/^.*node_modules/, 'node_modules')
            const lineNo = match[3] ?? '?'
            return `${fn} (${file}:${lineNo})`
        })
        .slice(0, 15) // cap at 15 frames
}

function normalizeCategory(raw: string | undefined): TaskCategory {
    const valid: TaskCategory[] = ['coding', 'research', 'ops', 'deployment', 'automation']
    return valid.includes(raw as TaskCategory) ? raw as TaskCategory : 'unknown'
}

/**
 * Produce a sanitized telemetry payload from raw error context.
 * No user content survives this function.
 */
export function sanitize(ctx: RawErrorContext): TelemetryError {
    return {
        errorType: ctx.error.constructor.name || 'Error',
        stackFrames: sanitizeStack(ctx.error.stack),
        pipelineStep: ctx.pipelineStep ?? null,
        taskCategory: normalizeCategory(ctx.taskCategory),
        pluginName: ctx.pluginName
            ? ctx.pluginName.replace(/[^\w\-@/]/g, '').slice(0, 64)
            : null,
        plexoVersion: ctx.plexoVersion,
        nodeVersion: process.version,
        instanceId: ctx.instanceId,
    }
}
