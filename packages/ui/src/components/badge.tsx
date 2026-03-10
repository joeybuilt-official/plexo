// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { cn } from '../lib/utils'

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: 'default' | 'success' | 'warning' | 'error' | 'info'
}

const variantClasses = {
    default: 'border-border bg-surface-2 text-text-secondary',
    success: 'border-emerald-800 bg-emerald-950 text-emerald',
    warning: 'border-amber-800 bg-amber-950 text-amber',
    error: 'border-red-800 bg-red-950 text-red',
    info: 'border-indigo-800 bg-indigo-950 text-indigo',
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
    return (
        <div
            className={cn(
                'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
                variantClasses[variant],
                className,
            )}
            {...props}
        />
    )
}
