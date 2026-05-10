// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { MarkdownRenderer } from './MarkdownRenderer'
import type { WorkRendererProps } from '../types'

/**
 * InstructionsRenderer — Phase 4.
 *
 * Wraps `MarkdownRenderer` in distinctive chrome and relies on its
 * enrichment pipeline (Plexo paths, API-key provider pills, action
 * buttons, tool mentions, generic URLs) to turn narrative steps into
 * actionable UI. Enrichment is forced on by clearing any `meta.enrich`
 * override that might have been set upstream.
 */
export function InstructionsRenderer(props: WorkRendererProps) {
    const forced: WorkRendererProps = {
        ...props,
        work: {
            ...props.work,
            meta: { ...(props.work.meta ?? {}), enrich: true },
        },
    }
    return (
        <div className="w-full h-full">
            <div className="mx-auto max-w-3xl w-full">
                <div className="px-6 pt-6">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-azure mb-1">Instructions</div>
                    <div className="h-px w-full bg-gradient-to-r from-azure/40 to-transparent" />
                </div>
                <MarkdownRenderer {...forced} />
            </div>
        </div>
    )
}
