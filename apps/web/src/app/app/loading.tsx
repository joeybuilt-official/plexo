// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export default function DashboardLoading() {
    return (
        <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
            <div className="animate-pulse">
                <div className="h-8 w-48 rounded-lg bg-surface-2" />
            </div>
            <div className="animate-pulse space-y-3">
                <div className="h-16 w-full rounded-lg bg-surface-2" />
                <div className="h-16 w-3/4 rounded-lg bg-surface-2" />
                <div className="h-16 w-5/6 rounded-lg bg-surface-2" />
            </div>
        </div>
    )
}
