// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import * as React from 'react'
import { cn } from '../lib/utils'

interface CardShellProps {
    title: string
    subtitle?: string
    isLoading: boolean
    error: Error | null
    onConfigClick?: () => void
    actions?: React.ReactNode
    children: React.ReactNode
    className?: string
}

function CardShellSkeleton() {
    return (
        <div className="animate-pulse space-y-3 p-5">
            <div className="h-3 w-1/3 rounded bg-surface-2" />
            <div className="h-3 w-2/3 rounded bg-surface-2" />
            <div className="h-3 w-1/2 rounded bg-surface-2" />
        </div>
    )
}

function CardShellError({ error, onRetry }: { error: Error; onRetry?: () => void }) {
    return (
        <div className="flex flex-col items-center justify-center gap-3 p-5 text-center">
            <p className="text-sm text-red">{error.message}</p>
            {onRetry && (
                <button
                    onClick={onRetry}
                    className="rounded-md bg-surface-2 px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-surface-3"
                >
                    Retry
                </button>
            )}
        </div>
    )
}

export function CardShell({
    title,
    subtitle,
    isLoading,
    error,
    onConfigClick,
    actions,
    children,
    className,
}: CardShellProps) {
    return (
        <div
            className={cn(
                'flex h-full flex-col rounded-xl border border-border bg-surface-1 text-text-primary shadow-sm backdrop-blur-sm',
                className,
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border-subtle px-5 py-3">
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{title}</h3>
                    {subtitle && <p className="truncate text-xs text-text-muted">{subtitle}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    {actions}
                    {onConfigClick && (
                        <button
                            onClick={onConfigClick}
                            className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-text-secondary"
                            aria-label="Card settings"
                        >
                            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            </svg>
                        </button>
                    )}
                </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-auto">
                {isLoading ? (
                    <CardShellSkeleton />
                ) : error ? (
                    <CardShellError error={error} />
                ) : (
                    children
                )}
            </div>
        </div>
    )
}
