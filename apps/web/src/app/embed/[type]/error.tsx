// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export default function EmbedError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-4 text-center">
            <p className="text-sm font-medium">Failed to load embedded view</p>
            <button
                onClick={reset}
                className="rounded px-3 py-1.5 text-xs font-medium text-white"
                style={{ background: '#3b82f6' }}
            >
                Retry
            </button>
        </div>
    )
}
