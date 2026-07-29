// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export default function ShareError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
            <h2 className="text-lg font-semibold">Unable to load shared content</h2>
            <p className="max-w-md text-sm text-text-muted">
                This shared link may have expired or the content is no longer available.
            </p>
            <button
                onClick={reset}
                className="rounded-md bg-azure px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
                Try again
            </button>
        </div>
    )
}
