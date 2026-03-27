// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface ToolCall {
    tool: string
    input: unknown
    output: unknown
}

interface StepData {
    id: string
    stepNumber: number
    model: string | null
    ok: boolean
    output: string | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    durationMs: number | null
    toolCalls: ToolCall[]
}

export function StepRow({ step }: { step: StepData }) {
    const [open, setOpen] = useState(false)

    return (
        <div className="rounded-xl border border-border bg-surface-1/30 overflow-hidden">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="flex items-center justify-between w-full p-3 text-left hover:bg-surface-2/30 transition-colors"
            >
                <div className="flex items-center gap-2 flex-wrap">
                    {open ? (
                        <ChevronDown className="h-3 w-3 shrink-0 text-text-muted" />
                    ) : (
                        <ChevronRight className="h-3 w-3 shrink-0 text-text-muted" />
                    )}
                    <span className={`text-[11px] font-medium ${step.ok ? 'text-azure' : 'text-red'}`}>
                        Step {step.stepNumber}
                    </span>
                    {step.model && (
                        <span className="rounded border border-azure-800/40 bg-azure/30 px-1.5 py-0.5 text-[10px] font-mono text-azure">
                            {step.model}
                        </span>
                    )}
                    {step.toolCalls?.map((tc, i) => (
                        <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-text-muted">
                            {tc.tool}
                        </span>
                    ))}
                </div>
                <div className="flex items-center gap-2 text-[10px] text-text-muted shrink-0 ml-2">
                    {step.durationMs != null && <span>{step.durationMs}ms</span>}
                    {step.tokensIn != null && <span>{step.tokensIn?.toLocaleString()}t</span>}
                </div>
            </button>

            {/* Collapsed preview */}
            {!open && step.output && (
                <div className="px-3 pb-3 -mt-1">
                    <p className="text-[11px] text-text-muted leading-relaxed line-clamp-3">
                        {step.output.slice(0, 400)}{step.output.length > 400 ? '…' : ''}
                    </p>
                </div>
            )}

            {/* Expanded details */}
            {open && (
                <div className="border-t border-border px-3 py-3 flex flex-col gap-3">
                    {/* Status and model routing */}
                    <div className="flex flex-wrap gap-2 text-[11px]">
                        <span className={`rounded px-1.5 py-0.5 font-mono ${step.ok ? 'bg-emerald-900/30 text-emerald-400' : 'bg-red-900/30 text-red-400'}`}>
                            {step.ok ? 'ok' : 'error'}
                        </span>
                        {step.model && (
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-text-secondary font-mono">
                                model: {step.model}
                            </span>
                        )}
                        {step.costUsd != null && (
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-text-muted font-mono">
                                ${step.costUsd.toFixed(5)}
                            </span>
                        )}
                    </div>

                    {/* Full outcome */}
                    {step.output && (
                        <div>
                            <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1">Output</p>
                            <p className="text-[11px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words">
                                {step.output}
                            </p>
                        </div>
                    )}

                    {/* Tool calls detail */}
                    {step.toolCalls?.length > 0 && (
                        <div>
                            <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1.5">
                                Tool calls ({step.toolCalls.length})
                            </p>
                            <div className="flex flex-col gap-2">
                                {step.toolCalls.map((tc, i) => (
                                    <details key={i} className="rounded-lg border border-border bg-canvas overflow-hidden group/tc">
                                        <summary className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-surface-2/40 transition-colors list-none text-[11px]">
                                            <span className="text-violet-400 font-mono font-medium">{tc.tool}</span>
                                            <span className="ml-auto text-[10px] text-text-muted shrink-0 group-open/tc:hidden">+</span>
                                            <span className="ml-auto text-[10px] text-text-muted shrink-0 hidden group-open/tc:inline">-</span>
                                        </summary>
                                        <div className="border-t border-border">
                                            {tc.input != null && (
                                                <div className="px-2.5 py-2">
                                                    <p className="text-[10px] text-text-muted mb-1">Input</p>
                                                    <pre className="text-[10px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                                                        {typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input, null, 2)}
                                                    </pre>
                                                </div>
                                            )}
                                            {tc.output != null && (
                                                <div className="px-2.5 py-2 border-t border-border">
                                                    <p className="text-[10px] text-text-muted mb-1">Output</p>
                                                    <pre className="text-[10px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                                                        {typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2)}
                                                    </pre>
                                                </div>
                                            )}
                                        </div>
                                    </details>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
