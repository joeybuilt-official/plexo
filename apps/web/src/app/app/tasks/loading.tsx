// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export default function TasksLoading() {
    return (
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
            <div className="animate-pulse">
                <div className="h-8 w-32 rounded-sm bg-surface-2" />
            </div>
            <div className="animate-pulse space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3 rounded-sm border border-border bg-surface-1 p-3">
                        <div className="h-4 w-4 rounded bg-surface-2" />
                        <div className="h-4 flex-1 rounded bg-surface-2" />
                        <div className="h-4 w-16 rounded bg-surface-2" />
                    </div>
                ))}
            </div>
        </div>
    )
}
