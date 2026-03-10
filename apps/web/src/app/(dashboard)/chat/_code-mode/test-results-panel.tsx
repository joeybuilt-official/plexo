// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import type { StepTestResultEvent } from './use-code-stream'

interface TestResultsPanelProps {
    results: StepTestResultEvent[]
    onRerun?: (testNames: string[]) => void
    className?: string
}

function StatusDot({ pass }: { pass: boolean }) {
    return (
        <span
            className={`inline-block w-2 h-2 rounded-full flex-shrink-0 mt-0.5 ${pass ? 'bg-emerald' : 'bg-red'}`}
        />
    )
}

export function TestResultsPanel({ results, onRerun, className = '' }: TestResultsPanelProps) {
    if (results.length === 0) {
        return (
            <div className={`flex items-center justify-center h-full text-xs text-text-muted font-mono select-none ${className}`}>
                <span className="opacity-50">no test results yet</span>
            </div>
        )
    }

    const passed = results.filter((r) => r.pass)
    const failed = results.filter((r) => !r.pass)

    const failedNames = failed.map((r) => r.name)

    return (
        <div className={`flex flex-col h-full ${className}`}>
            {/* Summary bar */}
            <div className="flex items-center gap-3 px-3 py-2 border-b border-border text-xs font-mono">
                <span className="text-emerald">{passed.length} passed</span>
                <span className="text-text-muted">·</span>
                <span className="text-red">{failed.length} failed</span>
                {failed.length > 0 && onRerun && (
                    <button
                        onClick={() => onRerun(failedNames)}
                        className="ml-auto px-2 py-0.5 text-xs rounded bg-surface-2 hover:bg-zinc-700 text-text-secondary transition-colors"
                    >
                        Re-run failed
                    </button>
                )}
            </div>

            {/* Result list */}
            <div className="overflow-auto flex-1 divide-y divide-zinc-800/50">
                {results.map((r, i) => (
                    <details key={i} className="group">
                        <summary className="flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-surface-1/60 list-none select-text">
                            <StatusDot pass={r.pass} />
                            <span className={`text-xs font-mono flex-1 ${r.pass ? 'text-text-secondary' : 'text-red-300'}`}>
                                {r.name}
                            </span>
                            {!r.pass && onRerun && (
                                <button
                                    onClick={(e) => { e.preventDefault(); onRerun([r.name]) }}
                                    className="text-xs px-1.5 py-0.5 rounded bg-surface-2 hover:bg-zinc-700 text-text-secondary transition-colors opacity-0 group-hover:opacity-100"
                                >
                                    rerun
                                </button>
                            )}
                        </summary>
                        {r.detail && (
                            <pre className="px-6 py-2 text-xs font-mono text-text-muted whitespace-pre-wrap bg-canvas/50">
                                {r.detail}
                            </pre>
                        )}
                    </details>
                ))}
            </div>
        </div>
    )
}
