// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { FileText, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'

import type { TaskAsset } from '@web/app/app/chat/_components/types'
import { WorkRenderer, resolveKind } from '@web/components/works/WorkRenderer'
import { KindBadge } from '@web/components/works/KindBadge'

/**
 * Phase 3 — replaces the inline `<pre>` renderer on the task detail page
 * with a collapsible accordion that delegates each work to the typed
 * WorkRenderer registry.
 */
export function TaskWorkList({ assets }: { assets: TaskAsset[] }) {
    const [openId, setOpenId] = useState<string | null>(null)

    function toggle(id: string) {
        setOpenId(prev => prev === id ? null : id)
    }

    return (
        <div className="flex flex-col gap-2">
            {assets.map((asset) => {
                const id = asset.artifactId ?? asset.filename
                const open = openId === id
                const sizeLabel = asset.bytes < 1024
                    ? `${asset.bytes}B`
                    : asset.bytes < 1024 * 1024
                        ? `${(asset.bytes / 1024).toFixed(1)}KB`
                        : `${(asset.bytes / (1024 * 1024)).toFixed(1)}MB`
                const kind = resolveKind(asset)
                return (
                    <div key={id} className="rounded-sm border border-border/60 bg-surface-2/40 overflow-hidden">
                        <button
                            type="button"
                            onClick={() => toggle(id)}
                            aria-expanded={open}
                            aria-label={`${open ? 'Collapse' : 'Expand'} ${asset.filename}`}
                            className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-2/40 transition-colors text-left"
                        >
                            <FileText className="h-3.5 w-3.5 shrink-0 text-azure" aria-hidden="true" />
                            <span className="flex-1 text-xs font-medium text-text-primary font-mono truncate">{asset.filename}</span>
                            <KindBadge kind={kind} size="xs" />
                            <span className="text-[11px] text-text-muted shrink-0">{sizeLabel}</span>
                            <ChevronRight className={`h-3 w-3 text-text-muted transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
                        </button>
                        {open && (
                            <div className="border-t border-border/60 max-h-[600px] overflow-auto">
                                {asset.isText && asset.content ? (
                                    <WorkRenderer
                                        work={asset}
                                        onAction={(action) => {
                                            if (action.type === 'copy') {
                                                navigator.clipboard.writeText(action.content).then(() => toast.success('Copied'))
                                            } else if (action.type === 'navigate') {
                                                if (action.internal) window.location.href = action.href
                                                else window.open(action.href, '_blank', 'noopener,noreferrer')
                                            } else {
                                                toast.info('Action ships in a later phase')
                                            }
                                        }}
                                    />
                                ) : (
                                    <div className="px-3 py-2 text-[11px] text-text-muted italic">Binary file</div>
                                )}
                            </div>
                        )}
                    </div>
                )
            })}
        </div>
    )
}
