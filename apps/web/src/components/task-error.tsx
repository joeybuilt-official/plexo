// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { presentError } from '@web/lib/error-presenter'

export function TaskError({ outcomeSummary, status }: {
    outcomeSummary: string
    status: string
}) {
    const [detailsOpen, setDetailsOpen] = useState(false)
    const presentation = presentError(outcomeSummary)

    const isFailed = status === 'blocked' || status === 'failed'
    const borderColor = isFailed ? 'border-red-900/40' : 'border-amber-900/40'
    const bgColor = isFailed ? 'bg-red-950/20' : 'bg-amber-950/20'

    if (!presentation) {
        return (
            <div className={`rounded-xl border ${borderColor} ${bgColor} p-4`}>
                <div className="flex items-start gap-2.5">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-red mt-0.5" />
                    <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-medium text-red-300 uppercase tracking-wider mb-1.5">
                            Something went wrong
                        </p>
                        <p className="text-sm text-text-primary leading-relaxed">{outcomeSummary}</p>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className={`rounded-xl border ${borderColor} ${bgColor} overflow-hidden`}>
            <div className="p-4">
                <div className="flex items-start gap-2.5">
                    <AlertTriangle className={`h-4 w-4 shrink-0 mt-0.5 ${isFailed ? 'text-red' : 'text-amber'}`} />
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-2">
                            <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${isFailed ? 'bg-red-900/30 text-red-400' : 'bg-amber-900/30 text-amber-400'}`}>
                                {presentation.code}
                            </span>
                        </div>
                        <p className="text-sm text-text-primary leading-relaxed mb-2">{presentation.what}</p>
                        <dl className="flex flex-col gap-1.5 text-[12px]">
                            <div className="flex gap-2">
                                <dt className="shrink-0 text-text-muted w-14">Cause</dt>
                                <dd className="text-text-secondary">{presentation.why}</dd>
                            </div>
                            <div className="flex gap-2">
                                <dt className="shrink-0 text-text-muted w-14">Next step</dt>
                                <dd className="text-text-secondary">{presentation.action}</dd>
                            </div>
                        </dl>
                    </div>
                </div>
            </div>
            <button
                onClick={() => setDetailsOpen(!detailsOpen)}
                className={`flex items-center gap-1.5 w-full px-4 py-2 text-[11px] text-text-muted hover:text-text-secondary transition-colors border-t ${isFailed ? 'border-red-900/20' : 'border-amber-900/20'}`}
            >
                {detailsOpen ? (
                    <ChevronDown className="h-3 w-3" />
                ) : (
                    <ChevronRight className="h-3 w-3" />
                )}
                Technical details
            </button>
            {detailsOpen && (
                <div className={`px-4 pb-3 border-t ${isFailed ? 'border-red-900/20' : 'border-amber-900/20'}`}>
                    <pre className="text-[11px] font-mono text-text-muted leading-relaxed whitespace-pre-wrap break-words pt-2">
                        {outcomeSummary}
                    </pre>
                </div>
            )}
        </div>
    )
}
