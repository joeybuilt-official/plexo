// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { Copy, Check, ExternalLink, FileCode, Terminal, Database, FileDiff } from 'lucide-react'

interface TaskWork {
    type: 'file' | 'diff' | 'url' | 'data' | 'command'
    label: string
    content: string
}

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)

    function handleCopy() {
        void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    return (
        <button
            onClick={handleCopy}
            title="Copy to clipboard"
            className="inline-flex items-center justify-center rounded p-1 text-text-muted hover:text-text-secondary hover:bg-surface-2/60 transition-colors shrink-0"
        >
            {copied
                ? <Check className="h-3 w-3 text-emerald-400" />
                : <Copy className="h-3 w-3" />
            }
        </button>
    )
}

export function WorkItem({ work }: { work: TaskWork }) {
    switch (work.type) {
        case 'file':
            return (
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2">
                    <FileCode className="h-3.5 w-3.5 text-azure shrink-0" />
                    <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-xs font-medium text-text-primary">{work.label}</span>
                        <span className="text-[11px] font-mono text-text-muted truncate">{work.content}</span>
                    </div>
                    <CopyButton text={work.content} />
                </div>
            )

        case 'diff':
            return (
                <div className="rounded-lg border border-border/60 bg-surface-1/40 overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/40">
                        <FileDiff className="h-3.5 w-3.5 text-yellow-400 shrink-0" />
                        <span className="text-xs font-medium text-text-primary">{work.label}</span>
                    </div>
                    <pre className="text-[11px] font-mono text-text-secondary leading-relaxed p-3 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">{work.content}</pre>
                </div>
            )

        case 'url':
            return (
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2">
                    <ExternalLink className="h-3.5 w-3.5 text-azure shrink-0" />
                    <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-xs font-medium text-text-primary">{work.label}</span>
                        <a
                            href={work.content}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-azure hover:text-azure-600 truncate transition-colors"
                        >
                            {work.content}
                        </a>
                    </div>
                </div>
            )

        case 'data':
            return (
                <details className="rounded-lg border border-border/60 bg-surface-1/40 overflow-hidden group/data">
                    <summary className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-2/40 transition-colors list-none">
                        <Database className="h-3.5 w-3.5 text-text-muted shrink-0" />
                        <span className="text-xs font-medium text-text-primary flex-1">{work.label}</span>
                        <span className="text-[10px] text-text-muted shrink-0 group-open/data:hidden">&#9656;</span>
                        <span className="text-[10px] text-text-muted shrink-0 hidden group-open/data:inline">&#9662;</span>
                    </summary>
                    <div className="border-t border-border/40">
                        <pre className="text-[11px] font-mono text-text-secondary leading-relaxed p-3 overflow-x-auto max-h-64 whitespace-pre-wrap break-words">{(() => {
                            try { return JSON.stringify(JSON.parse(work.content), null, 2) }
                            catch { return work.content }
                        })()}</pre>
                    </div>
                </details>
            )

        case 'command':
            return (
                <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-surface-1/40 px-3 py-2">
                    <Terminal className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    <div className="flex flex-col min-w-0 flex-1">
                        <span className="text-xs font-medium text-text-primary">{work.label}</span>
                        <code className="text-[11px] font-mono text-text-secondary mt-0.5">$ {work.content}</code>
                    </div>
                    <CopyButton text={work.content} />
                </div>
            )
    }
}
