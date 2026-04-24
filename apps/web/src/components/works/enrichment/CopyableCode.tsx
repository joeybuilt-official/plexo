// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 — inline `<code>` wrapper with a hover-activated copy button.
// Used by `MarkdownRenderer` (when enrichment is enabled) to replace
// raw inline code. Fenced code blocks are untouched — those already
// have their own syntax highlighting path.

'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export function CopyableCode({ children, className }: { children: React.ReactNode, className?: string }) {
    const [copied, setCopied] = useState(false)
    const raw = flattenText(children)

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(raw)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        } catch {
            // best effort; ignore
        }
    }

    return (
        <span className="group/code relative inline-flex items-center align-baseline">
            <code className={className}>{children}</code>
            <button
                type="button"
                onClick={handleCopy}
                className="ml-1 opacity-0 transition-opacity group-hover/code:opacity-100 text-text-muted hover:text-azure"
                title={copied ? 'Copied' : 'Copy'}
                aria-label={copied ? 'Copied' : 'Copy'}
            >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            </button>
        </span>
    )
}

function flattenText(node: React.ReactNode): string {
    if (node == null || node === false) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(flattenText).join('')
    if (typeof node === 'object' && node !== null && 'props' in (node as object)) {
        const el = node as unknown as { props: { children?: React.ReactNode } }
        return flattenText(el.props.children)
    }
    return ''
}
