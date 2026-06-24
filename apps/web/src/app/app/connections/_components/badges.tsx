// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { Globe2, Key, Webhook, CheckCircle2, Circle, AlertCircle, Copy, Check, Smartphone } from 'lucide-react'
import type { AuthType, ConnectionStatus } from './types'

export function AuthIcon({ type }: { type: AuthType }) {
    if (type === 'oauth2') return <Globe2 className="h-3.5 w-3.5 text-azure" />
    if (type === 'api_key' || type === 'bearer' || type === 'basic') return <Key className="h-3.5 w-3.5 text-amber" />
    if (type === 'webhook') return <Webhook className="h-3.5 w-3.5 text-violet-400" />
    if (type === 'paired_session') return <Smartphone className="h-3.5 w-3.5 text-green-400" />
    return null
}

export function AuthBadge({ type }: { type: AuthType }) {
    const map: Record<AuthType, { label: string; cls: string }> = {
        oauth2: { label: 'OAuth2', cls: 'bg-azure/10 text-azure border-azure/20' },
        api_key: { label: 'API Key / PAT', cls: 'bg-amber-dim text-amber border-amber-500/20' },
        bearer: { label: 'Bearer Token', cls: 'bg-amber-dim text-amber border-amber-500/20' },
        basic: { label: 'Basic Auth', cls: 'bg-amber-dim text-amber border-amber-500/20' },
        webhook: { label: 'Webhook', cls: 'bg-violet-500/10 text-violet-400 border-violet-500/20' },
        none: { label: 'No Auth', cls: 'bg-surface-2/30 text-text-muted border-border/30' },
        paired_session: { label: 'QR Paired', cls: 'bg-green-500/10 text-green-400 border-green-500/20' },
    }
    const entry = map[type] ?? map.none
    const { label, cls } = entry
    return (
        <span className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
            <AuthIcon type={type} />
            {label}
        </span>
    )
}

export function StatusDot({ status }: { status: ConnectionStatus }) {
    if (status === 'active') return <CheckCircle2 className="h-3.5 w-3.5 text-azure" />
    if (status === 'error') return <AlertCircle className="h-3.5 w-3.5 text-red" />
    return <Circle className="h-3.5 w-3.5 text-text-muted" />
}

export function CopySnippet({ code }: { code: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <div className="relative group">
            <pre className="rounded-sm border border-border bg-canvas p-3 text-[11px] font-mono text-text-secondary overflow-x-auto whitespace-pre leading-relaxed pr-9">{code}</pre>
            <button
                onClick={() => { void navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                className="absolute right-2 top-2 p-1.5 rounded-md bg-surface-2 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity hover:text-text-primary"
            >
                {copied ? <Check className="h-3 w-3 text-azure" /> : <Copy className="h-3 w-3" />}
            </button>
        </div>
    )
}

export function categoryColor(cat: string): string {
    const map: Record<string, string> = {
        code: 'bg-violet-500/15 text-violet-400 border border-violet-500/30',
        developer: 'bg-violet-500/15 text-violet-400 border border-violet-500/30',
        communication: 'bg-azure/15 text-azure border border-azure/30',
        productivity: 'bg-azure/15 text-azure border border-azure/30',
        finance: 'bg-amber/15 text-amber border border-amber-500/30',
        analytics: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30',
        storage: 'bg-amber/15 text-orange-400 border border-orange-500/30',
        mcp: 'bg-rose-500/15 text-rose-400 border border-rose-500/30',
        custom_api: 'bg-signal-green/15 text-emerald-400 border border-signal-green/30',
    }
    return map[cat.toLowerCase()] ?? 'bg-surface-2/40 text-text-secondary border border-border'
}
