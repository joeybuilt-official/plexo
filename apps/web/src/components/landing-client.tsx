// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useRef, useEffect, useState, type ReactNode } from 'react'

/**
 * ScrollReveal — IntersectionObserver-driven fade-up on scroll.
 * Adds data-visible="true" when element enters viewport, triggering
 * the CSS transition defined in globals.css (.reveal-section).
 */
export function ScrollReveal({ children, className, id }: {
    children: ReactNode
    className?: string
    id?: string
}) {
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const el = ref.current
        if (!el) return
        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    el.dataset.visible = 'true'
                    observer.unobserve(el)
                }
            },
            { threshold: 0.08, rootMargin: '0px 0px -40px 0px' },
        )
        observer.observe(el)
        return () => observer.disconnect()
    }, [])

    return (
        <div ref={ref} id={id} className={`reveal-section ${className ?? ''}`}>
            {children}
        </div>
    )
}

/**
 * CopyButton — clipboard copy with "Copied!" feedback.
 */
export function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)

    function handleCopy() {
        navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <button
            onClick={handleCopy}
            className="px-2 py-0.5 rounded text-[11px] font-mono text-text-muted hover:text-text-primary transition-colors"
        >
            {copied ? 'Copied!' : 'Copy'}
        </button>
    )
}
