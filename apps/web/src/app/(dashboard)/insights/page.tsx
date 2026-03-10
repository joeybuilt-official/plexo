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
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

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
    failure_pattern: { dot: 'bg-red-500', label: 'Failure pattern' },
    success_pattern: { dot: 'bg-emerald-500', label: 'Success pattern' },
    tool_preference: { dot: 'bg-blue-500', label: 'Tool preference' },
    scope_adjustment: { dot: 'bg-amber-500', label: 'Scope adjustment' },
    skill_proposal: { dot: 'bg-indigo-500', label: 'Skill Proposal' },
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
        <div className="flex flex-col gap-6 max-w-3xl">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Memory & Insights</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">Agent memory, learned preferences, and self-improvement proposals</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void load()}
                        disabled={loading}
                        className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => void runCycle()}
                        disabled={running || !WS_ID}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
                    >
                        {running ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
                        {running ? 'Running…' : 'Run improvement cycle'}
                    </button>
                </div>
            </div>

            {runMsg && (
                <div className={`rounded-lg border px-3 py-2 text-sm ${runMsg.ok ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald-400' : 'border-red-800/50 bg-red-950/20 text-red-400'}`}>
                    {runMsg.text}
                </div>
            )}

            {/* Memory search */}
            <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-2">
                    <Brain className="h-3.5 w-3.5" />
                    Memory Search
                </h2>
                <form onSubmit={handleSearch} className="flex gap-2">
                    <input
                        value={searchQ}
                        onChange={(e) => setSearchQ(e.target.value)}
                        placeholder="Semantic search across agent memory…"
                        className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                    />
                    <button
                        type="submit"
                        disabled={searching}
                        className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 transition-colors"
                    >
                        {searching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                        Search
                    </button>
                </form>
                {searchResults !== null && (
                    <div className="mt-3 flex flex-col gap-2">
                        {searchResults.length === 0 ? (
                            <p className="text-sm text-zinc-600 text-center py-6">No results found</p>
                        ) : searchResults.map((r) => (
                            <div key={r.id} className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
                                <p className="text-sm text-zinc-300 leading-relaxed">{r.content}</p>
                                {r.similarity !== undefined && (
                                    <p className="mt-1.5 text-[10px] text-zinc-600">similarity: {(r.similarity * 100).toFixed(1)}%</p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Preferences */}
            <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-2">
                    <Zap className="h-3.5 w-3.5" />
                    Workspace Preferences
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">{prefEntries.length}</span>
                </h2>
                {prefEntries.length === 0 ? (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-500">
                        No preferences learned yet. Preferences accumulate as the agent completes tasks.
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {prefEntries.map(([key, value]) => (
                            <div key={key} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                                <p className="text-[10px] font-mono text-zinc-500 truncate">{key}</p>
                                <p className="mt-1 text-xs font-medium text-zinc-300 break-all">
                                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                </p>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Improvement log */}
            <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 flex items-center gap-2">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Improvement Proposals
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">{improvements.length}</span>
                </h2>

                {improvements.length === 0 ? (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-10 text-center flex flex-col items-center gap-3">
                        <Brain className="h-7 w-7 text-zinc-700" />
                        <p className="text-sm text-zinc-500">No improvement proposals yet.</p>
                        <p className="text-xs text-zinc-600">Click &apos;Run improvement cycle&apos; above after completing some tasks.</p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {improvements.map((entry) => {
                            const style = PATTERN_STYLE[entry.pattern_type] ?? { dot: 'bg-zinc-600', label: entry.pattern_type }
                            return (
                                <div key={entry.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex items-start gap-2 min-w-0">
                                            <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
                                            <div className="min-w-0">
                                                <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">{style.label}</p>
                                                <p className="mt-0.5 text-sm text-zinc-200">{entry.description}</p>
                                                {entry.proposed_change && (
                                                    <p className="mt-1.5 text-xs text-zinc-500 italic">→ {entry.proposed_change}</p>
                                                )}
                                                <p className="mt-1.5 text-[10px] text-zinc-700">{timeAgo(entry.created_at)}</p>
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            {entry.applied ? (
                                                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                                                    applied
                                                </span>
                                            ) : (
                                                <button
                                                    onClick={() => void applyImprovement(entry.id)}
                                                    disabled={applying === entry.id}
                                                    className="rounded-lg bg-indigo-600/20 border border-indigo-500/30 px-2.5 py-1 text-[11px] font-medium text-indigo-400 hover:bg-indigo-600/30 disabled:opacity-40 transition-colors"
                                                >
                                                    {applying === entry.id ? 'Applying…' : 'Apply'}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                )}
            </section>
        </div>
    )
}
