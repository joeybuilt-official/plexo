// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { AlertCircle } from 'lucide-react'

export function ErrorFallback({ message, onRetry }: { message?: string; onRetry?: () => void }) {
    return (
        <div className="rounded border border-border bg-surface-1 p-12 text-center">
            <AlertCircle className="h-10 w-10 text-text-muted mx-auto mb-3" />
            <p className="text-sm font-medium text-text-secondary">{message ?? 'Something went wrong'}</p>
            <p className="text-xs text-text-muted mt-1">This may be temporary. Try refreshing the page.</p>
            {onRetry && (
                <button
                    onClick={onRetry}
                    className="btn-primary mt-4"
                >
                    Try again
                </button>
            )}
        </div>
    )
}
