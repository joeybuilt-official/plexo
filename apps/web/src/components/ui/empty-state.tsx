// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { LucideIcon } from 'lucide-react'
import Link from 'next/link'

interface EmptyStateProps {
    icon: LucideIcon
    headline: string
    description?: string
    actionLabel?: string
    actionHref?: string
    onAction?: () => void
}

export function EmptyState({ icon: Icon, headline, description, actionLabel, actionHref, onAction }: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center py-16 text-center">
            <Icon className="h-12 w-12 text-text-muted mb-3" />
            <p className="text-sm font-medium text-text-primary">{headline}</p>
            {description && (
                <p className="text-xs text-text-muted mt-1 max-w-xs leading-relaxed">{description}</p>
            )}
            {actionLabel && actionHref && (
                <Link
                    href={actionHref}
                    className="mt-4 flex items-center gap-1.5 rounded-lg bg-azure px-3 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure/60"
                >
                    {actionLabel}
                </Link>
            )}
            {actionLabel && onAction && !actionHref && (
                <button
                    onClick={onAction}
                    className="mt-4 flex items-center gap-1.5 rounded-lg bg-azure px-3 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure/60"
                >
                    {actionLabel}
                </button>
            )}
        </div>
    )
}
