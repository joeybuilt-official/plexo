// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { StepRow } from './_step-row'
import { useTaskStepStream, type RawTaskStep } from './_use-task-step-stream'

interface ToolCall {
    tool: string
    input: unknown
    output: unknown
}

function toToolCalls(value: unknown): ToolCall[] {
    if (!Array.isArray(value)) return []
    return value.map((tc) => {
        const o = (tc ?? {}) as Record<string, unknown>
        return {
            tool: (o.tool as string) ?? (o.name as string) ?? 'tool',
            input: o.input ?? o.args ?? null,
            output: o.output ?? o.result ?? null,
        }
    })
}

function toStepData(raw: RawTaskStep) {
    const started = raw.startedAt ? Date.parse(raw.startedAt) : NaN
    const completed = raw.completedAt ? Date.parse(raw.completedAt) : NaN
    const durationMs = !Number.isNaN(started) && !Number.isNaN(completed) ? completed - started : null
    return {
        id: raw.id,
        stepNumber: raw.stepNumber,
        model: null,
        ok: !raw.error && raw.state !== 'failed',
        output: raw.outcome ?? null,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        durationMs,
        toolCalls: toToolCalls(raw.toolCalls),
    }
}

/**
 * Live, SSE-fed view of a running task's steps. Renders nothing until the
 * first step arrives, so a quiet task doesn't show an empty shell.
 */
export function LiveSteps({ taskId, workspaceId }: { taskId: string; workspaceId: string }) {
    const { steps, doneStatus, connected } = useTaskStepStream(taskId, workspaceId)

    if (steps.length === 0) return null

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
                <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 rounded-full ${doneStatus ? 'bg-text-muted' : connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`}
                />
                <span className="text-[11px] uppercase tracking-wider text-text-muted">
                    {doneStatus ? `Finished — ${steps.length} step${steps.length === 1 ? '' : 's'}` : `Live activity — ${steps.length} step${steps.length === 1 ? '' : 's'}`}
                </span>
            </div>
            <div className="flex flex-col gap-2">
                {steps.map((raw) => (
                    <StepRow key={raw.id} step={toStepData(raw)} />
                ))}
            </div>
        </div>
    )
}
