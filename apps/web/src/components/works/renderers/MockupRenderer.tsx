// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useMemo, useState } from 'react'
import { Smartphone, Tablet, Monitor, Code as CodeIcon, ExternalLink } from 'lucide-react'

import { CodeRenderer } from './CodeRenderer'
import type { WorkRendererProps } from '../types'

/**
 * MockupRenderer — full-bleed, preview-first HTML. Phase 6 hardens the
 * sandbox: the iframe renders with `sandbox="allow-same-origin"` only
 * (no scripts, no forms, no popups) so untrusted agent-produced HTML
 * cannot execute. The "open in new tab" button serialises the content
 * into a blob URL so the user can inspect the unsandboxed mockup in
 * their own judgement.
 */
type Viewport = 'mobile' | 'tablet' | 'desktop'

const VIEWPORT_WIDTH: Record<Viewport, string> = {
    mobile: '390px',
    tablet: '820px',
    desktop: '100%',
}

export function MockupRenderer({ work }: WorkRendererProps) {
    const [viewport, setViewport] = useState<Viewport>('desktop')
    const [source, setSource] = useState(false)

    const blobUrl = useMemo(() => {
        if (typeof window === 'undefined' || !work.content) return null
        try {
            const blob = new Blob([work.content], { type: 'text/html' })
            return URL.createObjectURL(blob)
        } catch { return null }
    }, [work.content])

    if (!work.content) return null

    if (source) {
        return (
            <div className="flex flex-col h-full">
                <div className="flex items-center justify-end px-3 py-2 border-b border-border bg-surface-1/50">
                    <button
                        onClick={() => setSource(false)}
                        className="rounded-md px-2.5 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary flex items-center gap-1.5"
                    >
                        <Monitor className="h-3 w-3" />
                        Back to preview
                    </button>
                </div>
                <div className="flex-1 min-h-0 overflow-auto">
                    <CodeRenderer work={{ ...work, meta: { ...(work.meta ?? {}), language: 'html' } }} />
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-1/50">
                <div className="flex bg-surface-1 border border-border rounded p-0.5">
                    <VpButton active={viewport === 'mobile'}  onClick={() => setViewport('mobile')}  icon={<Smartphone className="h-3 w-3" />} />
                    <VpButton active={viewport === 'tablet'}  onClick={() => setViewport('tablet')}  icon={<Tablet className="h-3 w-3" />} />
                    <VpButton active={viewport === 'desktop'} onClick={() => setViewport('desktop')} icon={<Monitor className="h-3 w-3" />} />
                </div>
                <div className="flex items-center gap-1.5">
                    <a
                        href={blobUrl ?? '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-md px-2.5 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary flex items-center gap-1.5"
                        title="Open mockup in a new tab"
                    >
                        <ExternalLink className="h-3 w-3" />
                        Open in new tab
                    </a>
                    <button
                        onClick={() => setSource(true)}
                        className="rounded-md px-2.5 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary flex items-center gap-1.5"
                    >
                        <CodeIcon className="h-3 w-3" />
                        View source
                    </button>
                </div>
            </div>
            <div className="flex-1 min-h-0 overflow-auto flex items-start justify-center bg-surface-1/20 p-4">
                <iframe
                    srcDoc={work.content}
                    className="bg-white border-0 rounded-md"
                    sandbox="allow-same-origin"
                    style={{ width: VIEWPORT_WIDTH[viewport], height: '100%', minHeight: '600px' }}
                    title={work.filename}
                />
            </div>
        </div>
    )
}

function VpButton({ active, onClick, icon }: { active: boolean, onClick: () => void, icon: React.ReactNode }) {
    return (
        <button
            onClick={onClick}
            className={`rounded-md p-1 transition-colors ${active ? 'bg-surface-1 text-text-primary' : 'text-text-muted hover:text-text-primary'}`}
        >
            {icon}
        </button>
    )
}
