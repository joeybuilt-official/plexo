// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useViewMode, type ViewMode } from '@web/hooks/use-view-mode'

const OPTIONS: { value: ViewMode; label: string }[] = [
    { value: 'simple', label: 'Simple' },
    { value: 'advanced', label: 'Advanced' },
]

export function ViewModeToggle({ className = '' }: { className?: string }) {
    const { mode, setMode } = useViewMode()

    return (
        <div className={`flex items-center gap-1 rounded border border-border bg-canvas p-1 ${className}`}>
            {OPTIONS.map((opt) => (
                <button
                    key={opt.value}
                    type="button"
                    onClick={() => setMode(opt.value)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        mode === opt.value
                            ? 'bg-surface-2 text-text-primary'
                            : 'text-text-muted hover:text-text-secondary'
                    }`}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    )
}
