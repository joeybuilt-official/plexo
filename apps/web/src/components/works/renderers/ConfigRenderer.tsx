// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { Wand2 } from 'lucide-react'

import { CodeRenderer } from './CodeRenderer'
import type { WorkRendererProps } from '../types'

/**
 * ConfigRenderer — syntax-highlighted config view via Prism (the
 * existing react-syntax-highlighter dep). Phase 6 detects the language
 * from `meta.language` first, then from the filename. The "Apply to
 * workspace" button dispatches a `{ type: 'apply' }` action which the
 * panel wires to a confirm modal before executing.
 */
export function ConfigRenderer({ work, onAction }: WorkRendererProps) {
    const language = ((work.meta?.language as string | undefined) || detectConfigLanguage(work.filename)) || 'ini'

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-1/50">
                <div className="text-[11px] text-text-muted">
                    Config file — review before applying.
                    <span className="text-text-primary/60 uppercase tracking-wider ml-1">{language}</span>
                </div>
                <button
                    onClick={() => onAction?.({ type: 'apply', target: 'workspace', payload: { filename: work.filename, content: work.content, language } })}
                    className="rounded-md bg-azure/10 border border-azure/30 px-2.5 py-1 text-[11px] font-medium text-azure hover:bg-azure/20 transition-colors flex items-center gap-1.5"
                    title="Apply to workspace"
                >
                    <Wand2 className="h-3 w-3" />
                    Apply to workspace
                </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto">
                <CodeRenderer work={{ ...work, meta: { ...(work.meta ?? {}), language } }} />
            </div>
        </div>
    )
}

export function detectConfigLanguage(filename: string): string | null {
    const lower = (filename || '').toLowerCase()
    const base = lower.split('/').pop() || lower
    if (base === 'dockerfile' || base.endsWith('.dockerfile')) return 'dockerfile'
    if (base.endsWith('.toml')) return 'toml'
    if (base.endsWith('.ini') || base.endsWith('.conf') || base.endsWith('.cfg')) return 'ini'
    if (base === '.env' || base.endsWith('.env') || base.endsWith('.dotenv')) return 'bash'
    if (base === 'makefile' || base.endsWith('.mk')) return 'makefile'
    if (base.endsWith('.yaml') || base.endsWith('.yml')) return 'yaml'
    if (base.endsWith('.json')) return 'json'
    if (base.endsWith('.properties')) return 'properties'
    return null
}
