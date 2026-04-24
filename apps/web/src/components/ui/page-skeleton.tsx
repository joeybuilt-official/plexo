// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

interface PageSkeletonProps {
    rows?: number
    variant?: 'card' | 'list' | 'grid'
}

export function PageSkeleton({ rows = 5, variant = 'list' }: PageSkeletonProps) {
    if (variant === 'card') {
        return (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {Array.from({ length: rows }).map((_, i) => (
                    <div key={i} className="h-32 rounded-xl bg-surface-1/40 animate-pulse" />
                ))}
            </div>
        )
    }

    if (variant === 'grid') {
        return (
            <div className="space-y-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <div key={i} className="h-16 rounded-lg bg-surface-1/40 animate-pulse" />
                    ))}
                </div>
                <div className="h-64 rounded-xl bg-surface-1/40 animate-pulse" />
            </div>
        )
    }

    return (
        <div className="space-y-3">
            {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="h-16 rounded-lg bg-surface-1/40 animate-pulse" />
            ))}
        </div>
    )
}
