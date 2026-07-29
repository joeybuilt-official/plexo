// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

export default function ChatLoading() {
    return (
        <div className="flex flex-1 flex-col items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-text-muted font-mono">
                <span className="animate-pulse">_</span>
                <span>Loading chat</span>
            </div>
        </div>
    )
}
