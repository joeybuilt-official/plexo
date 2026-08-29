// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useRef, useEffect } from 'react'
import DOMPurify from 'dompurify'
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
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>')
        // Reset
        .replace(/\x1b\[0?m/g, '</span>')
        // Bright variants (must come before dim)
        .replace(/\x1b\[1;30m/g, '<span class="ansi-bright-black">')
        .replace(/\x1b\[1;31m/g, '<span class="ansi-bright-red">')
        .replace(/\x1b\[1;32m/g, '<span class="ansi-bright-green">')
        .replace(/\x1b\[1;33m/g, '<span class="ansi-bright-yellow">')
        .replace(/\x1b\[1;34m/g, '<span class="ansi-bright-blue">')
        .replace(/\x1b\[1;35m/g, '<span class="ansi-bright-magenta">')
        .replace(/\x1b\[1;36m/g, '<span class="ansi-bright-cyan">')
        .replace(/\x1b\[1;37m/g, '<span class="ansi-bright-white">')
        // Standard colours
        .replace(/\x1b\[30m/g, '<span class="ansi-black">')
        .replace(/\x1b\[31m/g, '<span class="ansi-red">')
        .replace(/\x1b\[32m/g, '<span class="ansi-green">')
        .replace(/\x1b\[33m/g, '<span class="ansi-yellow">')
        .replace(/\x1b\[34m/g, '<span class="ansi-blue">')
        .replace(/\x1b\[35m/g, '<span class="ansi-magenta">')
        .replace(/\x1b\[36m/g, '<span class="ansi-cyan">')
        .replace(/\x1b\[37m/g, '<span class="ansi-white">')
        // Background colours (mostly strip)
        .replace(/\x1b\[\d{1,3}(;\d{1,3})*m/g, '')
}

export function TerminalPanel({ lines, filterLabel, className = '' }: TerminalPanelProps) {
    const bottomRef = useRef<HTMLDivElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const preRef = useRef<HTMLPreElement>(null)
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

    function handleCopy() {
        const pre = preRef.current
        if (!pre) return
        const selection = window.getSelection()
        if (!selection) return
        const range = document.createRange()
        range.selectNodeContents(pre)
        selection.removeAllRanges()
        selection.addRange(range)
        document.execCommand('copy')
        selection.removeAllRanges()
    }

    if (filtered.length === 0) {
        return (
            <div className={`flex items-center justify-center h-full text-xs text-text-muted font-mono select-none ${className}`}>
                <span className="opacity-50">waiting for output…</span>
            </div>
        )
    }

    return (
        <div
            ref={containerRef}
            onScroll={handleScroll}
            tabIndex={0}
            role="log"
            aria-live="polite"
            className={`overflow-auto h-full bg-canvas px-3 py-2 relative ${className}`}
        >
            <button
                type="button"
                onClick={handleCopy}
                className="absolute top-2 right-2 text-xs text-text-secondary hover:text-text-primary font-sans px-2 py-1 rounded bg-surface-1 border border-border transition-colors"
                aria-label="Copy terminal output"
            >
                Copy output
            </button>
            <pre
                ref={preRef}
                className="text-xs font-mono leading-relaxed text-text-primary whitespace-pre-wrap break-all"
            >
                {filtered.map((l, i) => (
                    <span
                        key={i}
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderAnsi(l.line), { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['style'] }) + '\n' }}
                    />
                ))}
            </pre>
            <div ref={bottomRef} />
        </div>
    )
}
