// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 5 of intelligence-hardening — task debug viewer.
 *
 * Collapsible panel on /app/tasks/[id] that dumps each step's raw
 * `task_steps.stepState` JSONB. Fetches on expand via SWR so the
 * debug payload isn't paid on every page load. Workspace-member
 * gated by the API route (GET /api/v1/tasks/:id/steps/raw).
 */

'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { ChevronDown, ChevronRight, Bug, Loader2 } from 'lucide-react'
import { jsonFetcher } from '@web/lib/swr'

interface RawStep {
    stepNumber: number
    toolCalls: unknown
    stepState: unknown
    createdAt: string
}

interface RawStepsResponse {
    taskId: string
    steps: RawStep[]
    total: number
    truncated: boolean
}

interface RawStepsPanelProps {
    taskId: string
}

export function RawStepsPanel({ taskId }: RawStepsPanelProps) {
    const [open, setOpen] = useState(false)
    const { data, isLoading, error } = useSWR<RawStepsResponse>(
        open ? `/api/v1/tasks/${taskId}/steps/raw` : null,
        jsonFetcher,
    )

    return (
        <div className="rounded-sm border border-border/60 bg-surface-1/40">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-surface-2/40"
            >
                {open ? (
                    <ChevronDown className="h-4 w-4 text-text-muted" aria-hidden="true" />
                ) : (
                    <ChevronRight className="h-4 w-4 text-text-muted" aria-hidden="true" />
                )}
                <Bug className="h-4 w-4 text-text-muted" aria-hidden="true" />
                <span className="text-sm font-medium text-text-primary">Raw task steps</span>
                <span className="ml-auto text-[11px] font-mono text-text-muted">debug</span>
            </button>
            {open && (
                <div className="border-t border-border/60 p-4">
                    {isLoading && (
                        <div className="flex items-center gap-2 text-xs text-text-muted">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            Loading step state…
                        </div>
                    )}
                    {error && (
                        <div className="text-xs text-rose-400">
                            Failed to load raw steps. You may not have access, or the task no longer exists.
                        </div>
                    )}
                    {data && (
                        <div className="flex flex-col gap-2">
                            {data.steps.length === 0 && (
                                <div className="text-xs text-text-muted">No steps recorded yet.</div>
                            )}
                            {data.steps.map((step) => (
                                <details
                                    key={step.stepNumber}
                                    className="rounded-md border border-border/40 bg-surface-2/30 p-2"
                                >
                                    <summary className="cursor-pointer text-xs font-medium text-text-primary">
                                        Step {step.stepNumber}
                                        <span className="ml-2 font-mono text-[11px] text-text-muted">
                                            {new Date(step.createdAt).toLocaleTimeString()}
                                        </span>
                                    </summary>
                                    <div className="mt-2">
                                        <div className="text-[11px] font-medium text-text-secondary">stepState</div>
                                        <pre className="mt-1 max-h-96 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-snug text-text-secondary">
                                            {JSON.stringify(step.stepState, null, 2)}
                                        </pre>
                                    </div>
                                    {step.toolCalls !== null && step.toolCalls !== undefined && (
                                        <div className="mt-2">
                                            <div className="text-[11px] font-medium text-text-secondary">toolCalls</div>
                                            <pre className="mt-1 max-h-96 overflow-auto rounded bg-black/40 p-2 text-[10px] leading-snug text-text-secondary">
                                                {JSON.stringify(step.toolCalls, null, 2)}
                                            </pre>
                                        </div>
                                    )}
                                </details>
                            ))}
                            {data.truncated && (
                                <div className="mt-1 text-[11px] text-amber-400">
                                    Results truncated to first {data.total} steps — older entries may exist in the database.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
