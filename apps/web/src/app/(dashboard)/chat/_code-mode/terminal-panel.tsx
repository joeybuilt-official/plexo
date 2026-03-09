// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useRef, useEffect } from 'react'
import type { StepShellLineEvent } from './use-code-stream'

interface TerminalPanelProps {
    lines: StepShellLineEvent[]
    /** If provided, filter to only show lines with this label */
    filterLabel?: string
    className?: string
}

// Minimal ANSI colour renderer — handles the most common escape sequences
function renderAnsi(line: string): string {
    return line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Reset
        .replace(/\x1b\[0?m/g, '</span>')
        // Bright variants (must come before dim)
        .replace(/\x1b\[1;30m/g, '<span style="color:#686868">')
        .replace(/\x1b\[1;31m/g, '<span style="color:#ff5f5f">')
        .replace(/\x1b\[1;32m/g, '<span style="color:#5fff5f">')
        .replace(/\x1b\[1;33m/g, '<span style="color:#ffff5f">')
        .replace(/\x1b\[1;34m/g, '<span style="color:#5f87ff">')
        .replace(/\x1b\[1;35m/g, '<span style="color:#ff5fff">')
        .replace(/\x1b\[1;36m/g, '<span style="color:#5fffff">')
        .replace(/\x1b\[1;37m/g, '<span style="color:#ffffff">')
        // Standard colours
        .replace(/\x1b\[30m/g, '<span style="color:#686868">')
        .replace(/\x1b\[31m/g, '<span style="color:#e74c3c">')
        .replace(/\x1b\[32m/g, '<span style="color:#2ecc71">')
        .replace(/\x1b\[33m/g, '<span style="color:#f39c12">')
        .replace(/\x1b\[34m/g, '<span style="color:#5f87ff">')
        .replace(/\x1b\[35m/g, '<span style="color:#9b59b6">')
        .replace(/\x1b\[36m/g, '<span style="color:#1abc9c">')
        .replace(/\x1b\[37m/g, '<span style="color:#bdc3c7">')
        // Background colours (mostly strip)
        .replace(/\x1b\[\d{1,3}(;\d{1,3})*m/g, '')
}

export function TerminalPanel({ lines, filterLabel, className = '' }: TerminalPanelProps) {
    const bottomRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const isAtBottomRef = useRef(true)

    const filtered = filterLabel ? lines.filter((l) => l.label === filterLabel) : lines

    // Auto-scroll unless user scrolled up
    useEffect(() => {
        if (!isAtBottomRef.current) return
        bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    }, [filtered.length])

    function handleScroll() {
        const el = containerRef.current
        if (!el) return
        isAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }

    if (filtered.length === 0) {
        return (
            <div className={`flex items-center justify-center h-full text-xs text-zinc-500 font-mono select-none ${className}`}>
                <span className="opacity-50">waiting for output…</span>
            </div>
        )
    }

    return (
        <div
            ref={containerRef}
            onScroll={handleScroll}
            className={`overflow-auto h-full bg-zinc-950 px-3 py-2 ${className}`}
        >
            <pre className="text-xs font-mono leading-relaxed text-zinc-200 whitespace-pre-wrap break-all">
                {filtered.map((l, i) => (
                    <span
                        key={i}
                        dangerouslySetInnerHTML={{ __html: renderAnsi(l.line) + '\n' }}
                    />
                ))}
            </pre>
            <div ref={bottomRef} />
        </div>
    )
}
