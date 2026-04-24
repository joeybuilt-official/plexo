// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { Monitor, Code as CodeIcon } from 'lucide-react'

import { CodeRenderer } from './CodeRenderer'
import type { WorkRendererProps } from '../types'

/**
 * HtmlRenderer — tabs for Preview (sandboxed iframe) and Code. Code view
 * is the default for a raw HTML work; mockups flip this (see
 * MockupRenderer).
 */
export function HtmlRenderer({ work }: WorkRendererProps) {
    const [tab, setTab] = useState<'preview' | 'code'>('code')
    if (!work.content) return null

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center gap-1 px-3 py-2 border-b border-border/40 bg-surface-2/30">
                <TabButton active={tab === 'preview'} onClick={() => setTab('preview')} icon={<Monitor className="h-3 w-3" />} label="Preview" />
                <TabButton active={tab === 'code'} onClick={() => setTab('code')} icon={<CodeIcon className="h-3 w-3" />} label="Code" />
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
                {tab === 'preview' ? (
                    <iframe
                        srcDoc={work.content}
                        className="w-full h-full bg-white border-0"
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
                active ? 'bg-surface-2/80 text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
            }`}
        >
            {icon}
            {label}
        </button>
    )
}
