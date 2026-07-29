// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import Link from 'next/link'

interface PlexoAwarenessBadgeProps {
    action: string
    model?: string
    agentCount?: number
    compact?: boolean
}

/**
 * Small awareness badge indicating Plexo AI involvement.
 * Shows on every AI-powered surface. Links to getplexo.com.
 */
export function PlexoAwarenessBadge({ action, model, compact }: PlexoAwarenessBadgeProps) {
    if (compact) {
        return (
            <Link
                href="https://getplexo.com"
                target="_blank"
                rel="noopener noreferrer"
                data-testid="plexo-awareness-badge"
                className="inline-flex items-center gap-1 rounded bg-surface-1 px-2 py-0.5 text-[11px] text-text-muted hover:text-text-primary transition-colors border border-border"
                title={`${action}${model ? ` · ${model}` : ''}`}
            >
                <PlexoIcon />
            </Link>
        )
    }

    return (
        <Link
            href="https://getplexo.com"
            target="_blank"
            rel="noopener noreferrer"
            data-testid="plexo-awareness-badge"
            className="inline-flex items-center gap-1.5 rounded bg-surface-1 px-2.5 py-1 text-[11px] text-text-muted hover:text-text-primary transition-colors border border-border"
        >
            <PlexoIcon />
            <span>{action}</span>
            {model && <span className="opacity-60">· {model}</span>}
        </Link>
    )
}

function PlexoIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
        </svg>
    )
}
