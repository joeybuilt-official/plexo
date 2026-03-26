// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'

interface VerificationChecklistProps {
    steps: string[]
}

export function VerificationChecklist({ steps }: VerificationChecklistProps) {
    const [checked, setChecked] = useState<boolean[]>(() => new Array(steps.length).fill(false))

    function toggle(index: number) {
        setChecked(prev => {
            const next = [...prev]
            next[index] = !next[index]
            return next
        })
    }

    if (steps.length === 0) return null

    return (
        <div>
            <p className="text-[10px] text-text-muted uppercase tracking-wider mb-1.5">Verification steps</p>
            <ol className="flex flex-col gap-1">
                {steps.map((step, i) => (
                    <li key={i} className="flex items-start gap-2">
                        <button
                            onClick={() => toggle(i)}
                            className="mt-0.5 flex items-center justify-center h-4 w-4 rounded border border-border/80 bg-surface-1/40 shrink-0 transition-colors hover:border-azure/50"
                            aria-label={`Mark step ${i + 1} as ${checked[i] ? 'incomplete' : 'complete'}`}
                        >
                            {checked[i] && (
                                <svg className="h-2.5 w-2.5 text-azure" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M2 6l3 3 5-5" />
                                </svg>
                            )}
                        </button>
                        <span className={`text-xs leading-relaxed ${checked[i] ? 'text-text-muted line-through' : 'text-text-secondary'}`}>
                            <span className="text-text-muted mr-1">{i + 1}.</span>
                            {step}
                        </span>
                    </li>
                ))}
            </ol>
        </div>
    )
}
