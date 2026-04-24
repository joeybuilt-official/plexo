// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export default function ChatLoading() {
    return (
        <div className="flex flex-1 flex-col">
            {/* Message area */}
            <div className="flex-1 space-y-4 overflow-hidden p-4 md:p-6">
                <div className="animate-pulse space-y-4">
                    <div className="ml-auto h-10 w-2/5 rounded-lg bg-surface-2" />
                    <div className="h-10 w-3/5 rounded-lg bg-surface-2" />
                    <div className="ml-auto h-10 w-1/3 rounded-lg bg-surface-2" />
                    <div className="h-16 w-2/3 rounded-lg bg-surface-2" />
                </div>
            </div>
            {/* Composer placeholder */}
            <div className="border-t border-border p-4">
                <div className="animate-pulse">
                    <div className="h-12 w-full rounded-lg bg-surface-2" />
                </div>
            </div>
        </div>
    )
}
