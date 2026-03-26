'use client'

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * First-task completion acknowledgment.
 * Shown once per workspace when the first task completes successfully.
 * Brief, clean confirmation — not a celebration. Resolves after 2s.
 */

import { useState, useEffect } from 'react'
import { CheckCheck } from 'lucide-react'

interface Props {
    taskName: string
    outcome: string
    worksCount: number
    durationMs: number
    onDismiss: () => void
}

export function TaskCompletionMoment({ taskName, outcome, worksCount, durationMs, onDismiss }: Props) {
    const [visible, setVisible] = useState(true)

    useEffect(() => {
        const timer = setTimeout(() => {
            setVisible(false)
            setTimeout(onDismiss, 300) // wait for fade-out
        }, 2000)
        return () => clearTimeout(timer)
    }, [onDismiss])

    const seconds = (durationMs / 1000).toFixed(1)

    return (
        <div className={`rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`}>
            <div className="flex items-center justify-center gap-2 mb-3">
                <CheckCheck className="h-5 w-5 text-emerald-400" />
                <span className="text-sm font-medium text-emerald-400">Task complete</span>
            </div>
            <p className="text-sm text-text-primary mb-1 truncate max-w-md mx-auto">{taskName}</p>
            <div className="flex items-center justify-center gap-3 text-[11px] text-text-muted">
                <span>{outcome}</span>
                {worksCount > 0 && <><span>&middot;</span><span>{worksCount} work{worksCount !== 1 ? 's' : ''} produced</span></>}
                <span>&middot;</span>
                <span>{seconds}s</span>
            </div>
        </div>
    )
}

const STORAGE_KEY = 'plexo_first_completion_shown'

/** Check if the first-completion moment has been shown for this workspace */
export function hasShownFirstCompletion(): boolean {
    if (typeof window === 'undefined') return true
    return localStorage.getItem(STORAGE_KEY) === 'true'
}

/** Mark the first-completion moment as shown */
export function markFirstCompletionShown(): void {
    if (typeof window === 'undefined') return
    localStorage.setItem(STORAGE_KEY, 'true')
}
