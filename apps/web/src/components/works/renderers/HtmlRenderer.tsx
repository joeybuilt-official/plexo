// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useMemo, useState } from 'react'
import { Monitor, Code as CodeIcon, ExternalLink } from 'lucide-react'

import { CodeRenderer } from './CodeRenderer'
import type { WorkRendererProps } from '../types'

/**
 * HtmlRenderer — tabs for Preview (sandboxed iframe) and Code. A full HTML
 * document (e.g. a self-contained game/app) defaults to Preview so it is
 * playable on open; a raw HTML fragment defaults to Code. "Open in new tab"
 * serialises the content into a blob URL so the user can run it full-size.
 */
export function HtmlRenderer({ work }: WorkRendererProps) {
    const isFullDoc = /<!doctype html|<html[\s>]/i.test(work.content ?? '')
    const [tab, setTab] = useState<'preview' | 'code'>(isFullDoc ? 'preview' : 'code')

    const blobUrl = useMemo(() => {
        if (typeof window === 'undefined' || !work.content) return null
        try {
            return URL.createObjectURL(new Blob([work.content], { type: 'text/html' }))
        } catch { return null }
    }, [work.content])

    if (!work.content) return null

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-surface-2/30">
                <div className="flex items-center gap-1">
                    <TabButton active={tab === 'preview'} onClick={() => setTab('preview')} icon={<Monitor className="h-3 w-3" />} label="Preview" />
                    <TabButton active={tab === 'code'} onClick={() => setTab('code')} icon={<CodeIcon className="h-3 w-3" />} label="Code" />
                </div>
                <a
                    href={blobUrl ?? undefined}
                    aria-disabled={!blobUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`rounded-md px-2.5 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary flex items-center gap-1.5 ${blobUrl ? '' : 'pointer-events-none opacity-40'}`}
                    title={blobUrl ? 'Open full-size in a new tab' : 'Preview not available'}
                >
                    <ExternalLink className="h-3 w-3" />
                    Open in new tab
                </a>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
                {tab === 'preview' ? (
                    <iframe
                        srcDoc={work.content}
                        className="w-full h-full min-h-[70vh] bg-white border-0"
                        sandbox="allow-scripts allow-forms allow-popups"
                        title={work.filename}
                    />
                ) : (
                    <CodeRenderer work={{ ...work, meta: { ...(work.meta ?? {}), language: 'html' } }} />
                )}
            </div>
        </div>
    )
}

function TabButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
    return (
        <button
            onClick={onClick}
            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors flex items-center gap-1.5 ${
                active ? 'bg-surface-2/80 text-text-primary' : 'text-text-muted hover:text-text-secondary'
            }`}
        >
            {icon}
            {label}
        </button>
    )
}
