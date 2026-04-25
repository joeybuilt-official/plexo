// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { PlexoMark } from '@web/components/plexo-logo'

export default function ConnectionsError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
            <PlexoMark className="h-10 w-10 text-text-muted" />
            <h2 className="text-lg font-medium text-text-primary">Failed to load connections</h2>
            <p className="max-w-md text-center text-sm text-text-muted">
                Something went wrong while loading your connections. Try again or refresh the page.
            </p>
            <button
                onClick={reset}
                className="rounded-md bg-azure px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
                Try again
            </button>
            <details className="mt-2 max-w-lg text-xs text-text-muted">
                <summary className="cursor-pointer hover:text-text-primary">Error details</summary>
                <pre className="mt-2 overflow-auto rounded-md border border-border bg-surface-1 p-3">
                    {error.message}
                </pre>
            </details>
        </div>
    )
}
