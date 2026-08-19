// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect } from 'react'
import { PlexoMark } from '@web/components/plexo-logo'
import { isChunkLoadError } from './chunk-load-error'

export default function DashboardError({
    error,
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    useEffect(() => {
        if (!isChunkLoadError(error)) return
        const KEY = 'plexo:chunk-reload-at'
        const last = Number(sessionStorage.getItem(KEY) ?? '0')
        // Already reloaded for a stale chunk within the last 10s → the reload did
        // not resolve it, so stop and surface the error rather than looping.
        if (Date.now() - last < 10_000) return
        sessionStorage.setItem(KEY, String(Date.now()))
        window.location.reload()
    }, [error])

    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
            <PlexoMark className="h-10 w-10 text-text-muted" />
            <h2 className="text-lg font-medium text-text-primary">Something went wrong</h2>
            <p className="max-w-md text-center text-sm text-text-muted">
                An unexpected error occurred. Try again or head back to the dashboard.
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
