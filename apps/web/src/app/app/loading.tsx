// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

export default function DashboardLoading() {
    return (
        <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
            <div className="flex items-center gap-2 text-sm text-text-muted font-mono">
                <span className="animate-pulse">_</span>
                <span>Loading</span>
            </div>
        </div>
    )
}
