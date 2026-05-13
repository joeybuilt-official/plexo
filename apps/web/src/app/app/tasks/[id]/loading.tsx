// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export default function TaskDetailLoading() {
    return (
        <div className="flex flex-col gap-5 max-w-3xl animate-pulse">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 md:h-8 md:w-8 rounded-sm bg-surface-2" />
                    <div className="flex items-center gap-2 flex-wrap">
                        <div className="h-5 w-20 rounded-full bg-surface-2" />
                        <div className="h-5 w-16 rounded bg-surface-2" />
                        <div className="h-5 w-24 rounded bg-surface-2" />
                    </div>
                </div>
            </div>

            {/* Request block */}
            <div className="rounded-sm border border-border/60 bg-surface-1/40 p-4 flex flex-col gap-2">
                <div className="h-3 w-16 rounded bg-surface-2" />
                <div className="h-4 w-full rounded bg-surface-2" />
                <div className="h-4 w-4/5 rounded bg-surface-2" />
            </div>

            {/* Status block */}
            <div className="rounded-sm border border-azure/20 bg-azure/5 p-4 flex items-center gap-3">
                <div className="h-4 w-4 rounded-full bg-surface-2 shrink-0" />
                <div className="h-4 w-48 rounded bg-surface-2" />
            </div>

            {/* Stats row */}
            <div className="flex flex-wrap gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="h-7 w-24 rounded border border-border bg-surface-1/40" />
                ))}
            </div>
        </div>
    )
}
