// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import * as React from 'react'
import { cn } from '../lib/utils'
import * as Icons from 'lucide-react'

interface CategoryBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    label: string
    iconName: string
    className?: string
}

export function CategoryBadge({ 
    label, 
    iconName, 
    className,
    ...props 
}: CategoryBadgeProps) {
    const Icon = // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic icon lookup
    (Icons as any)[iconName] || Icons.Sparkles

    return (
        <span 
            className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ring-zinc-700/60 bg-surface-2/60 text-text-secondary",
                className
            )}
            {...props}
        >
            <Icon className="h-2.5 w-2.5" />
            {label}
        </span>
    )
}
