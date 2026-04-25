// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { RefreshCw, Target, BookOpen, Brain, Layers } from 'lucide-react'
import { Section } from './ui-primitives'
import { API } from './types'

interface ExtPrompt {
    id: string
    extensionName: string
    promptId: string
    name: string
    description: string
    template: string
    variables: Array<{ name: string; description: string; type: string; required?: boolean; default?: unknown }>
    variableDefaults: Record<string, unknown>
    tags: string[]
    version: string
    priority: string
    enabled: boolean
}

interface ExtContext {
    id: string
    extensionName: string
    contextId: string
    name: string
    description: string
    content: string
    priority: string
    ttl: number | null
    estimatedTokens: number | null
    computedTokens: number
    expired: boolean
    enabled: boolean
}

interface BudgetInfo {
    totalTokens: number
    activeContextCount: number
    byExtension: Record<string, { tokens: number; count: number }>
    budgetLimit: number
    utilization: number
}

export default function ExtensionPromptsTab({ workspaceId }: { workspaceId: string }) {
    const [prompts, setPrompts] = useState<ExtPrompt[]>([])
    const [contexts, setContexts] = useState<ExtContext[]>([])
    const [budget, setBudget] = useState<BudgetInfo | null>(null)
    const [loading, setLoading] = useState(true)

    const load = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const [pRes, cRes, bRes] = await Promise.all([
                fetch(`${API}/api/v1/prompts/${workspaceId}`),
                fetch(`${API}/api/v1/context/${workspaceId}`),
                fetch(`${API}/api/v1/context/${workspaceId}/budget`),
            ])
            if (pRes.ok) { const d = await pRes.json() as { items: ExtPrompt[] }; setPrompts(d.items) }
            if (cRes.ok) { const d = await cRes.json() as { items: ExtContext[] }; setContexts(d.items) }
            if (bRes.ok) { setBudget(await bRes.json() as BudgetInfo) }
        } catch { /* non-fatal */ }
        setLoading(false)
    }, [workspaceId])

    useEffect(() => { void load() }, [load])

    const togglePrompt = async (id: string, enabled: boolean) => {
        await fetch(`${API}/api/v1/prompts/${workspaceId}/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        })
        void load()
    }

    const toggleContext = async (id: string, enabled: boolean) => {
        await fetch(`${API}/api/v1/context/${workspaceId}/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        })
        void load()
    }

    if (loading) return <div className="flex items-center gap-2 py-8 text-sm text-text-muted"><RefreshCw className="h-4 w-4 animate-spin" /> Loading tools…</div>

    const noData = prompts.length === 0 && contexts.length === 0

    return (
        <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            {noData && (
                <div className="text-center py-12 text-text-muted text-sm">
                    <Layers className="h-8 w-8 mx-auto mb-3 opacity-40" />
                    <p>No tool prompts or context blocks installed.</p>
                    <p className="text-xs mt-1">Install an extension with prompts to see them here.</p>
                </div>
            )}

            {budget && budget.activeContextCount > 0 && (
                <Section title="Context Token Budget" icon={Target}>
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center gap-3">
                            <div className="flex-1 h-2 bg-surface-secondary rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${budget.utilization > 0.8 ? 'bg-red-500' : budget.utilization > 0.5 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                                    style={{ width: `${Math.min(budget.utilization * 100, 100)}%` }}
                                />
                            </div>
                            <span className="text-xs text-text-muted whitespace-nowrap">
                                {budget.totalTokens.toLocaleString()} / {budget.budgetLimit.toLocaleString()} tokens
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {Object.entries(budget.byExtension).map(([ext, info]) => (
                                <span key={ext} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface-secondary text-xs text-text-secondary">
                                    {ext}: {info.tokens.toLocaleString()} tokens ({info.count} blocks)
                                </span>
                            ))}
                        </div>
                    </div>
                </Section>
            )}

            {prompts.length > 0 && (
                <Section title="Tool Prompts" icon={BookOpen}>
                    <div className="flex flex-col gap-3">
                        {prompts.map((p) => (
                            <div key={p.id} className="flex items-start gap-3 p-3 rounded-sm border border-border bg-surface-primary">
                                <button
                                    onClick={() => void togglePrompt(p.id, !p.enabled)}
                                    className={`mt-0.5 shrink-0 w-9 h-5 rounded-full transition-colors ${p.enabled ? 'bg-emerald-600' : 'bg-surface-secondary'}`}
                                >
                                    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${p.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-text-primary">{p.name}</span>
                                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-secondary text-text-muted">{p.priority}</span>
                                        <span className="text-[11px] text-text-muted">v{p.version}</span>
                                    </div>
                                    <p className="text-xs text-text-muted mt-0.5">{p.extensionName}</p>
                                    {p.description && <p className="text-xs text-text-secondary mt-1">{p.description}</p>}
                                    {p.variables.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-2">
                                            {p.variables.map((v) => (
                                                <span key={v.name} className="text-[11px] px-1.5 py-0.5 rounded bg-azure/10 text-azure">
                                                    {`{{${v.name}}}`}{v.required !== false ? '*' : ''}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {contexts.length > 0 && (
                <Section title="Tool Context" icon={Brain}>
                    <div className="flex flex-col gap-3">
                        {contexts.map((c) => (
                            <div key={c.id} className={`flex items-start gap-3 p-3 rounded-sm border bg-surface-primary ${c.expired ? 'border-amber-800/40 opacity-60' : 'border-border'}`}>
                                <button
                                    onClick={() => void toggleContext(c.id, !c.enabled)}
                                    className={`mt-0.5 shrink-0 w-9 h-5 rounded-full transition-colors ${c.enabled ? 'bg-emerald-600' : 'bg-surface-secondary'}`}
                                >
                                    <div className={`w-4 h-4 rounded-full bg-white transition-transform ${c.enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
                                </button>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-medium text-text-primary">{c.name}</span>
                                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-surface-secondary text-text-muted">{c.priority}</span>
                                        <span className="text-[11px] text-text-muted">~{c.computedTokens.toLocaleString()} tokens</span>
                                        {c.expired && <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-900/30 text-amber">expired</span>}
                                    </div>
                                    <p className="text-xs text-text-muted mt-0.5">{c.extensionName}</p>
                                    {c.description && <p className="text-xs text-text-secondary mt-1">{c.description}</p>}
                                    {c.ttl != null && <p className="text-[11px] text-text-muted mt-1">TTL: {c.ttl}s</p>}
                                </div>
                            </div>
                        ))}
                    </div>
                </Section>
            )}
        </div>
    )
}
