// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { AlertTriangle } from 'lucide-react'

interface PageErrorProps {
    message?: string
    detail?: string
    onRetry?: () => void
}

export function PageError({ message = 'Something went wrong', detail, onRetry }: PageErrorProps) {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <AlertTriangle className="h-12 w-12 text-red mb-3" />
            <p className="text-sm font-medium text-text-primary">{message}</p>
            {detail && (
                <p className="text-xs text-text-muted mt-1 max-w-md leading-relaxed">{detail}</p>
            )}
            {onRetry && (
                <button
                    onClick={onRetry}
                    className="btn-secondary mt-4"
                >
                    Try again
                </button>
            )}
        </div>
    )
}
