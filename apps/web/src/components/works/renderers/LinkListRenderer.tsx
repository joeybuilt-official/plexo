// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useMemo, useState } from 'react'
import { ExternalLink, Layers } from 'lucide-react'

import type { WorkRendererProps } from '../types'

interface LinkEntry {
    title: string
    url: string
    host: string
    description?: string
}

const OPEN_ALL_CONFIRM_THRESHOLD = 5

/**
 * LinkListRenderer — parses markdown bullet lists of links into cards.
 * Phase 5 adds an "open all" button that prompts for confirmation when
 * more than 5 links would open in new tabs.
 */
export function LinkListRenderer({ work, onAction }: WorkRendererProps) {
    const links = useMemo(() => parseLinks(work.content ?? ''), [work.content])
    const [confirming, setConfirming] = useState(false)

    if (links.length === 0) {
        return <div className="p-6 text-sm text-text-muted italic">No links detected in content.</div>
    }

    function openOne(url: string) {
        onAction?.({ type: 'navigate', href: url, internal: false })
        if (typeof window !== 'undefined') {
            window.open(url, '_blank', 'noopener,noreferrer')
        }
    }

    function openAll() {
        if (links.length > OPEN_ALL_CONFIRM_THRESHOLD && !confirming) {
            setConfirming(true)
            return
        }
        setConfirming(false)
        for (const l of links) {
            if (typeof window !== 'undefined') {
                window.open(l.url, '_blank', 'noopener,noreferrer')
            }
            onAction?.({ type: 'navigate', href: l.url, internal: false })
        }
    }

    return (
        <div className="p-6 max-w-3xl mx-auto flex flex-col gap-2">
            <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] uppercase tracking-wider text-text-muted">
                    {links.length} link{links.length === 1 ? '' : 's'}
                </span>
                <div className="flex items-center gap-2">
                    {confirming && (
                        <span className="text-[11px] text-text-primary">
                            Open all {links.length} links?
                        </span>
                    )}
                    <button
                        onClick={openAll}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-medium border transition-colors flex items-center gap-1.5 ${
                            confirming
                                ? 'bg-red-500/10 border-red-400/40 text-red-300 hover:bg-red-500/20'
                                : 'bg-surface-1 border-border text-text-primary hover:bg-surface-1/80'
                        }`}
                    >
                        <Layers className="h-3 w-3" />
                        {confirming ? `Confirm open ${links.length}` : 'Open all'}
                    </button>
                    {confirming && (
                        <button
                            onClick={() => setConfirming(false)}
                            className="rounded-md px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
                        >
                            Cancel
                        </button>
                    )}
                </div>
            </div>
            {links.map((l, i) => (
                <button
                    type="button"
                    key={`${l.url}-${i}`}
                    onClick={() => openOne(l.url)}
                    className="group flex items-center gap-3 rounded border border-border bg-surface-1/40 px-4 py-3 hover:bg-surface-1/70 transition-colors text-left"
                >
                    <div
                        className="h-8 w-8 rounded bg-surface-1 flex items-center justify-center shrink-0 overflow-hidden"
                        aria-hidden="true"
                    >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(l.host)}&sz=32`}
                            alt=""
                            className="h-4 w-4"
                        />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-text-primary truncate">{l.title}</div>
                        {l.description && (
                            <div className="text-[11px] text-text-muted truncate">{l.description}</div>
                        )}
                        <div className="text-[11px] text-azure truncate">{l.url}</div>
                    </div>
                    <ExternalLink className="h-3.5 w-3.5 text-text-muted group-hover:text-text-primary shrink-0" />
                </button>
            ))}
        </div>
    )
}

export function parseLinks(content: string): LinkEntry[] {
    const out: LinkEntry[] = []
    const lines = content.split('\n')
    const mdLink = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*(?:[—-]\s*(.*))?$/
    const bareLink = /(https?:\/\/\S+)/

    for (const raw of lines) {
        const line = raw.replace(/^\s*[-*]\s+/, '').trim()
        if (!line) continue
        const m = mdLink.exec(line)
        if (m) {
            const url = m[2]!
            out.push({
                title: m[1]!,
                url,
                host: safeHost(url),
                description: m[3]?.trim() || undefined,
            })
            continue
        }
        const bm = bareLink.exec(line)
        if (bm) {
            const url = bm[1]!
            out.push({
                title: url.replace(/^https?:\/\//, '').replace(/\/$/, ''),
                url,
                host: safeHost(url),
            })
        }
    }
    return out
}

function safeHost(url: string): string {
    try { return new URL(url).hostname } catch { return url }
}
