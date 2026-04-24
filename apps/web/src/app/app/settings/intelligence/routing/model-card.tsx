// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * ModelCard — Phase 2b chain entry row.
 *
 * Renders one routing-chain entry as a draggable card with:
 *   - position number
 *   - model id + provider
 *   - capability/strength/latency/cost badges (via ModelAttributeBadges)
 *   - up/down/remove controls
 *
 * Drag-reorder happens at the editor level (parent owns the list state).
 * The card itself is presentational + emits intent callbacks.
 */

import { GripVertical, ArrowUp, ArrowDown, Trash2 } from 'lucide-react'
import { ModelAttributeBadges, type ModelAttributesView } from '../model-attribute-badges'

export interface ChainModelCardProps {
    position: number
    providerType: string
    modelId: string
    /** Optional attribute view — when missing, only the name + provider show. */
    attributes?: ModelAttributesView | null
    isFirst: boolean
    isLast: boolean
    onMoveUp: () => void
    onMoveDown: () => void
    onRemove: () => void
    disabled?: boolean
}

export function ChainModelCard(props: ChainModelCardProps) {
    const { position, providerType, modelId, attributes, isFirst, isLast, onMoveUp, onMoveDown, onRemove, disabled } = props
    return (
        <div className="flex items-start gap-3 rounded-xl border border-border bg-surface-1 p-3">
            <div className="flex flex-col items-center gap-1 text-text-muted">
                <GripVertical className="h-4 w-4" aria-hidden />
                <span className="text-[11px] tabular-nums">#{position + 1}</span>
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-primary truncate">{modelId}</span>
                    <span className="text-[11px] text-text-muted">{providerType}</span>
                </div>
                {attributes ? (
                    <div className="mt-1.5">
                        <ModelAttributeBadges attributes={attributes} compact />
                    </div>
                ) : (
                    <p className="mt-1 text-[11px] text-text-muted">No attributes available — model not in catalog.</p>
                )}
                {attributes?.bestForHint && (
                    <p className="mt-1 text-[11px] text-text-muted leading-snug">{attributes.bestForHint}</p>
                )}
            </div>
            <div className="flex flex-col gap-1">
                <button
                    type="button"
                    aria-label="Move up"
                    disabled={disabled || isFirst}
                    onClick={onMoveUp}
                    className="rounded-md border border-border bg-surface-1 p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
                >
                    <ArrowUp className="h-3 w-3" />
                </button>
                <button
                    type="button"
                    aria-label="Move down"
                    disabled={disabled || isLast}
                    onClick={onMoveDown}
                    className="rounded-md border border-border bg-surface-1 p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
                >
                    <ArrowDown className="h-3 w-3" />
                </button>
                <button
                    type="button"
                    aria-label="Remove"
                    disabled={disabled}
                    onClick={onRemove}
                    className="rounded-md border border-border bg-surface-1 p-1 text-text-muted hover:text-rose-400 disabled:opacity-30"
                >
                    <Trash2 className="h-3 w-3" />
                </button>
            </div>
        </div>
    )
}
