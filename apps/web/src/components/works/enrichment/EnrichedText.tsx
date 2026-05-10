// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 — render a plain-text string as a sequence of enriched
// segments (plain text / internal link / external link / API-key pill
// / action button / tool mention). Consumed by the Markdown text-node
// override in `MarkdownRenderer`.
//
// Kept intentionally small; all matching logic lives in
// `@web/lib/works/enrichment-patterns` as pure functions.

'use client'

import Link from 'next/link'
import { ExternalLink, KeyRound, Plug, Zap, ArrowRight } from 'lucide-react'

import { enrichText, type EnrichedSegment } from '@web/lib/works/enrichment-patterns'
import type { WorkAction } from '@web/components/works/types'

export interface EnrichedTextProps {
    value: string
    onAction?: (action: WorkAction) => void
}

export function EnrichedText({ value, onAction }: EnrichedTextProps) {
    if (!value) return null
    const segments = enrichText(value)
    return (
        <>
            {segments.map((seg, i) => (
                <EnrichedSegmentView key={i} segment={seg} onAction={onAction} />
            ))}
        </>
    )
}

function EnrichedSegmentView({ segment, onAction }: { segment: EnrichedSegment, onAction?: (action: WorkAction) => void }) {
    switch (segment.kind) {
        case 'text':
            return <>{segment.value}</>

        case 'internal-link':
            return (
                <Link
                    href={segment.href}
                    className="inline-flex items-center gap-0.5 text-azure underline decoration-azure/30 underline-offset-2 hover:decoration-azure"
                >
                    {segment.raw}
                    <ArrowRight className="inline h-3 w-3 opacity-60" aria-hidden />
                </Link>
            )

        case 'external-link':
            return (
                <a
                    href={segment.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-azure underline decoration-azure/30 underline-offset-2 hover:decoration-azure break-all"
                >
                    {segment.raw}
                    <ExternalLink className="inline h-3 w-3 opacity-60" aria-hidden />
                </a>
            )

        case 'api-key-link':
            return (
                <a
                    href={segment.provider.keyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded-md border border-azure/30 bg-azure/10 px-1.5 py-0.5 text-xs font-medium text-azure hover:border-azure hover:bg-azure/15 align-baseline"
                    title={`Open ${segment.provider.name} API key page`}
                >
                    <KeyRound className="h-3 w-3" aria-hidden />
                    <span>Get {segment.provider.name} API key</span>
                    <ExternalLink className="h-3 w-3 opacity-60" aria-hidden />
                </a>
            )

        case 'action': {
            const label = segment.entry.label(segment.match)
            const icon = segment.match[0]?.toLowerCase().includes('tool') ? <Zap className="h-3 w-3" aria-hidden /> : <Plug className="h-3 w-3" aria-hidden />
            return (
                <button
                    type="button"
                    onClick={() => onAction?.(segment.entry.action(segment.match))}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-1.5 py-0.5 text-xs font-medium text-text-primary hover:border-azure/60 hover:text-azure align-baseline"
                    title={label}
                >
                    {icon}
                    <span>{label}</span>
                </button>
            )
        }

        case 'tool-mention':
            return (
                <code className="rounded bg-surface-2 px-1 py-0.5 text-[0.85em] font-mono text-text-primary">
                    {segment.toolName}
                </code>
            )
    }
}
