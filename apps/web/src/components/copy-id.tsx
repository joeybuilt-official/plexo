// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

interface CopyIdProps {
    id: string
    /** Display prefix label, e.g. "session", "task", "project" */
    label?: string
    className?: string
}

/**
 * Discreet copy-on-click ID chip.
 * Shows first 8 chars of the ID; clicking copies the full value to clipboard.
 */
export function CopyId({ id, label, className = '' }: CopyIdProps) {
    const [copied, setCopied] = useState(false)

    function handleClick() {
        void navigator.clipboard.writeText(id).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    return (
        <button
            onClick={handleClick}
            title={`Copy ${label ?? 'ID'}: ${id}`}
            className={`group inline-flex items-center gap-1 rounded-md border border-border/50 bg-surface-1/40 px-1.5 py-0.5 font-mono text-[11px] text-text-muted transition-all hover:border-border hover:bg-surface-2/60 hover:text-text-secondary active:scale-95 ${className}`}
        >
            {label && <span className="text-text-muted/60 not-italic font-sans">{label}:</span>}
            <span>{id.slice(0, 8)}</span>
            {copied
                ? <Check className="h-2.5 w-2.5 text-azure shrink-0" />
                : <Copy className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
            }
        </button>
    )
}
