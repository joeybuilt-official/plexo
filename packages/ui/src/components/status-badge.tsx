// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import * as React from 'react'
import { cn } from '../lib/utils'
import { STATUS_MAP, type StatusKey } from '../lib/status-config'

interface StatusBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    status: string
    showIcon?: boolean
    variant?: 'badge' | 'dot' | 'text'
    size?: 'xs' | 'sm' | 'md'
}

export function StatusBadge({ 
    status, 
    showIcon = true, 
    variant = 'badge',
    size = 'md',
    className,
    ...props 
}: StatusBadgeProps) {
    const config = STATUS_MAP[status as StatusKey]
    
    if (!config) {
        return (
            <span className={cn('text-[11px] text-text-muted', className)} {...props}>
                {status}
            </span>
        )
    }

    const { label, color, bgColor, borderColor, dotColor, icon: Icon, animate } = config

    const sizeClasses = {
        xs: 'px-1.5 py-0.5 text-[9px] gap-1',
        sm: 'px-2 py-0.5 text-[10px] gap-1',
        md: 'px-2.5 py-0.5 text-[11px] gap-1.5'
    }

    const iconSizes = {
        xs: 'h-2 w-2',
        sm: 'h-2.5 w-2.5',
        md: 'h-3 w-3'
    }

    if (variant === 'dot') {
        return (
            <div className={cn('flex items-center gap-2', className)} {...props}>
                <span className={cn('h-2 w-2 rounded-full', dotColor, animate && 'animate-pulse')} />
                <span className={cn('text-xs font-medium', color)}>{label}</span>
            </div>
        )
    }

    if (variant === 'text') {
        return (
            <span className={cn('text-xs font-medium', color, className)} {...props}>
                {label}
            </span>
        )
    }

    return (
        <span
            className={cn(
                'inline-flex items-center rounded-full border font-medium transition-all duration-300',
                sizeClasses[size],
                bgColor,
                borderColor,
                color,
                className
            )}
            {...props}
        >
            {showIcon && Icon && (
                <Icon className={cn(iconSizes[size], animate && 'animate-pulse')} />
            )}
            {!showIcon && (
                <span className={cn('h-1.5 w-1.5 rounded-full', dotColor, animate && 'animate-pulse')} />
            )}
            {label}
        </span>
    )
}
