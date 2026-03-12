// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useCallback, useEffect } from 'react'
import {
    Brain,
    RefreshCw,
    CheckCircle2,
    Zap,
    Search,
    PlayCircle,
    Clock,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { PlexoMark } from '@web/components/plexo-logo'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface ImprovementEntry {
    id: string
    pattern_type: string
    description: string
    evidence: unknown
    proposed_change: string | null
    applied: boolean
    created_at: string
}

interface SearchResult {
    id: string
    content: string
    metadata: Record<string, unknown>
    similarity?: number
}

const PATTERN_STYLE: Record<string, { dot: string; label: string }> = {
    failure_pattern: { dot: 'bg-red', label: 'Failure pattern' },
    success_pattern: { dot: 'bg-azure', label: 'Success pattern' },
    tool_preference: { dot: 'bg-blue-500', label: 'Tool preference' },
    scope_adjustment: { dot: 'bg-amber', label: 'Scope adjustment' },
    skill_proposal: { dot: 'bg-azure-500', label: 'Skill Proposal' },
    plugin_proposal: { dot: 'bg-purple-500', label: 'Plugin Proposal' },
    agent_proposal: { dot: 'bg-fuchsia-500', label: 'Agent Proposal' },
}

function timeAgo(iso: string) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

export default function InsightsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [improvements, setImprovements] = useState<ImprovementEntry[]>([])
    const [preferences, setPreferences] = useState<Record<string, unknown>>({})
    const [loading, setLoading] = useState(false)
    const [running, setRunning] = useState(false)
    const [applying, setApplying] = useState<string | null>(null)
    const [searchQ, setSearchQ] = useState('')
    const [searching, setSearching] = useState(false)
    const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)
    const [runMsg, setRunMsg] = useState<{ ok: boolean; text: string } | null>(null)

    const load = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const [impRes, prefRes, memRes] = await Promise.all([
                fetch(`${API_BASE}/api/v1/memory/improvements?workspaceId=${WS_ID}&limit=30`),
                fetch(`${API_BASE}/api/v1/memory/preferences?workspaceId=${WS_ID}`),
                fetch(`${API_BASE}/api/v1/memory/search?workspaceId=${WS_ID}&q=&limit=10`),
            ])
            if (impRes.ok) {
                const d = await impRes.json() as { items: ImprovementEntry[] }
                setImprovements(d.items ?? [])
            }
            if (prefRes.ok) {
                const d = await prefRes.json() as { preferences: Record<string, unknown> }
                setPreferences(d.preferences ?? {})
            }
            if (memRes.ok) {
                const d = await memRes.json() as { results: SearchResult[] }
                setSearchResults(d.results ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    // Load on first render
    useEffect(() => { void load() }, [load])

    async function runCycle() {
        setRunning(true)
        setRunMsg(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/memory/improvements/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID }),
            })
            const data = await res.json() as { ok?: boolean; message?: string; count?: number; proposals?: ImprovementEntry[]; error?: { message: string } }
            if (res.ok) {
                setRunMsg({ ok: true, text: `Cycle complete — ${data.count ?? 0} proposal(s) generated` })
                // Use proposals from response directly (no extra round-trip needed)
                if (Array.isArray(data.proposals)) {
                    setImprovements(data.proposals)
                } else {
                    await load()
                }
            } else {
                setRunMsg({ ok: false, text: data.error?.message ?? data.message ?? 'Failed' })
            }
        } catch {
            setRunMsg({ ok: false, text: 'Network error' })
        } finally {
            setRunning(false)
        }
    }

    async function applyImprovement(id: string) {
        setApplying(id)
        try {
            const res = await fetch(`${API_BASE}/api/v1/memory/improvements/${id}/apply`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID }),
            })
            if (res.ok) {
                setImprovements((prev) => prev.map((e) => e.id === id ? { ...e, applied: true } : e))
            }
        } finally {
            setApplying(null)
        }
    }

    async function handleSearch(e: React.FormEvent) {
        e.preventDefault()
        if (!WS_ID) return
        setSearching(true)
        setSearchResults(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/memory/search?workspaceId=${WS_ID}&q=${encodeURIComponent(searchQ)}&limit=10`)
            if (res.ok) {
                const data = await res.json() as { results: SearchResult[] }
                setSearchResults(data.results ?? [])
            }
        } finally {
            setSearching(false)
        }
    }

    const prefEntries = Object.entries(preferences)

    return (
        <div className="flex flex-col gap-6 max-w-6xl">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Memory & Insights</h1>
                    <p className="mt-0.5 text-sm text-text-muted">Agent memory, learned preferences, and self-improvement proposals</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void load()}
                        disabled={loading}
                        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs text-text-muted hover:text-text-secondary transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => void runCycle()}
                        disabled={running || !WS_ID}
                        className="flex items-center gap-1.5 rounded-lg bg-azure px-3 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 disabled:opacity-40 transition-colors"
                    >
                        {running ? <PlexoMark className="h-3.5 w-3.5" idle={false} working /> : <PlayCircle className="h-3.5 w-3.5" />}
                        {running ? 'Running…' : 'Run improvement cycle'}
                    </button>
                </div>
            </div>

            {runMsg && (
                <div className={`rounded-lg border px-3 py-2 text-sm ${runMsg.ok ? 'border-azure/30 bg-azure/20 text-azure' : 'border-red-800/50 bg-red-950/20 text-red'}`}>
                    {runMsg.text}
                </div>
            )}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
                {/* Main Content (Left) */}
                <div className="lg:col-span-7 flex flex-col gap-8">
                    {/* Memory search */}
                    <section>
                        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
                            <Brain className="h-3.5 w-3.5" />
                            Memory Search
                        </h2>
                        <form onSubmit={handleSearch} className="flex gap-2">
                            <input
                                value={searchQ}
                                onChange={(e) => setSearchQ(e.target.value)}
                                placeholder="Semantic search across agent memory…"
                                className="flex-1 rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                            />
                            <button
                                type="submit"
                                disabled={searching}
                                className="flex items-center gap-1.5 rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-secondary hover:bg-zinc-700 disabled:opacity-40 transition-colors"
                            >
                                {searching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                                Search
                            </button>
                        </form>
                        {searchResults !== null && (
                            <div className="mt-3 flex flex-col gap-2">
                                {searchResults.length === 0 ? (
                                    <p className="text-sm text-text-muted text-center py-6">No results found</p>
                                ) : searchResults.map((r) => (
                                    <div key={r.id} className="rounded-lg border border-border bg-surface-1/40 p-3">
                                        <p className="text-sm text-text-secondary leading-relaxed">{r.content}</p>
                                        {r.similarity !== undefined && (
                                            <p className="mt-1.5 text-[10px] text-text-muted">similarity: {(r.similarity * 100).toFixed(1)}%</p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    {/* Preferences */}
                    <section>
                        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
                            <Zap className="h-3.5 w-3.5" />
                            Workspace Preferences
                            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">{prefEntries.length}</span>
                        </h2>
                        {prefEntries.length === 0 ? (
                            <div className="rounded-xl border border-border bg-surface-1/40 p-6 text-center text-sm text-text-muted">
                                No preferences learned yet. Preferences accumulate as the agent completes tasks.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                {prefEntries.map(([key, value]) => (
                                    <div key={key} className="rounded-lg border border-border bg-surface-1/60 p-3">
                                        <p className="text-[10px] font-mono text-text-muted truncate">{key}</p>
                                        <p className="mt-1 text-xs font-medium text-text-secondary break-all">
                                            {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                        </p>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>
                </div>

                {/* Sidebar (Right) */}
                <div className="lg:col-span-5 flex flex-col gap-4 sticky top-6">
                    <section className="rounded-2xl border border-border bg-surface-1/40 p-5">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted flex items-center gap-2">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Improvement Proposals
                            </h2>
                            <span className="rounded-full bg-azure/10 px-2 py-0.5 text-[10px] font-bold text-azure ring-1 ring-inset ring-azure/20">
                                {improvements.filter(i => !i.applied).length} pending
                            </span>
                        </div>

                        {improvements.length === 0 ? (
                            <div className="py-10 text-center flex flex-col items-center gap-3">
                                <Brain className="h-7 w-7 text-zinc-700" />
                                <p className="text-sm text-text-muted">No improvement proposals yet.</p>
                                <p className="text-xs text-text-muted">Click &apos;Run improvement cycle&apos; above after completing some tasks.</p>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-3 max-h-[calc(100vh-250px)] overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-zinc-800">
                                {improvements.map((entry) => {
                                    const style = PATTERN_STYLE[entry.pattern_type] ?? { dot: 'bg-surface-3', label: entry.pattern_type }
                                    const isPending = !entry.applied
                                    return (
                                        <div 
                                            key={entry.id} 
                                            className={`rounded-xl border transition-all ${isPending ? 'border-azure/30 bg-azure/5 shadow-sm shadow-azure/5' : 'border-border bg-surface-1/60 opacity-70'} p-3.5`}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="flex items-start gap-2.5 min-w-0">
                                                    <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${style.dot} ${isPending ? 'animate-pulse' : ''}`} />
                                                    <div className="min-w-0">
                                                        <div className="flex items-center gap-2">
                                                            <p className="text-[10px] font-bold uppercase tracking-wide text-text-muted">{style.label}</p>
                                                            {isPending && <span className="h-1 w-1 rounded-full bg-azure" />}
                                                        </div>
                                                        <p className="mt-1 text-sm font-medium text-text-primary leading-tight">{entry.description}</p>
                                                        {entry.proposed_change && (
                                                            <div className="mt-2 rounded-md bg-zinc-950/40 p-2 border border-border/50">
                                                                <p className="text-[11px] text-text-muted italic leading-normal">
                                                                    <span className="text-azure-dim not-italic font-bold mr-1">PROPOSAL:</span>
                                                                    {entry.proposed_change}
                                                                </p>
                                                            </div>
                                                        )}
                                                        <p className="mt-2.5 text-[10px] text-text-muted/60 flex items-center gap-1">
                                                            <Clock className="h-2.5 w-2.5" />
                                                            {timeAgo(entry.created_at)}
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                            <div className="mt-3.5 flex items-center justify-end border-t border-border/40 pt-3">
                                                {entry.applied ? (
                                                    <div className="flex items-center gap-1.5 text-azure">
                                                        <CheckCircle2 className="h-3.5 w-3.5" />
                                                        <span className="text-[11px] font-bold uppercase tracking-wider">Applied</span>
                                                    </div>
                                                ) : (
                                                    <button
                                                        onClick={() => void applyImprovement(entry.id)}
                                                        disabled={applying === entry.id}
                                                        className="w-full rounded-lg bg-azure px-3 py-1.5 text-[11px] font-bold text-white hover:bg-azure/90 disabled:opacity-40 transition-all flex items-center justify-center gap-1.5 shadow-sm shadow-azure/20"
                                                    >
                                                        {applying === entry.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3 fill-current" />}
                                                        {applying === entry.id ? 'Applying…' : 'Approve & Apply'}
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    )
}
