'use client'

import { useState } from 'react'
import { Copy, Check } from 'lucide-react'

export function InstallButton({ name }: { name: string }) {
    const [copied, setCopied] = useState(false)
    const command = `plexo install ${name}`

    async function handleCopy() {
        await navigator.clipboard.writeText(command)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    return (
        <button
            onClick={handleCopy}
            className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-surface-2 border border-border hover:border-azure/40 transition-colors group"
        >
            <code className="text-sm text-text-secondary font-mono flex-1 text-left truncate">
                {command}
            </code>
            <span className="shrink-0 flex items-center gap-1.5 text-xs font-medium text-azure group-hover:text-azure-600 transition-colors">
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied ? 'Copied' : 'Copy'}
            </span>
        </button>
    )
}
