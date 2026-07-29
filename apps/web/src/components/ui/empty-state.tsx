// SPDX-License-Identifier: MIT
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
                    className="btn-primary mt-4"
                >
                    {actionLabel}
                </Link>
            )}
            {actionLabel && onAction && !actionHref && (
                <button
                    onClick={onAction}
                    className="btn-primary mt-4"
                >
                    {actionLabel}
                </button>
            )}
        </div>
    )
}
