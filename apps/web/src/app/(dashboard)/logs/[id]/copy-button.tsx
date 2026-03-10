// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
    const [copied, setCopied] = useState(false)

    async function copy() {
        await navigator.clipboard.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <button
            onClick={copy}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/50 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
            {copied ? <Check size={12} className="text-azure" /> : <Copy size={12} />}
            {copied ? 'Copied' : label}
        </button>
    )
}
