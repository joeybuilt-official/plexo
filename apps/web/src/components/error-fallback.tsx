// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { AlertCircle } from 'lucide-react'

export function ErrorFallback({ message, onRetry }: { message?: string; onRetry?: () => void }) {
    return (
        <div className="rounded border border-border bg-surface-1/40 p-12 text-center">
            <AlertCircle className="h-10 w-10 text-text-muted mx-auto mb-3" />
            <p className="text-sm font-medium text-text-secondary">{message ?? 'Something went wrong'}</p>
            <p className="text-xs text-text-muted mt-1">This may be temporary. Try refreshing the page.</p>
            {onRetry && (
                <button
                    onClick={onRetry}
                    className="mt-4 rounded bg-azure px-4 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors"
                >
                    Try again
                </button>
            )}
        </div>
    )
}
