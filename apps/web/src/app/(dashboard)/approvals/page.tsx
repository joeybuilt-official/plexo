'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    ShieldAlert,
    CheckCircle,
    XCircle,
    Clock,
    RefreshCw,
    AlertTriangle,
    ChevronDown,
    ChevronUp,
    SlidersHorizontal,
    CheckCheck,
    Ban,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

interface Approval {
    id: string
    taskId: string
    workspaceId: string
    operation: string
    description: string
    riskLevel: 'low' | 'medium' | 'high' | 'critical'
    decision: 'pending' | 'approved' | 'rejected'
    createdAt: string
    decidedAt?: string
    decidedBy?: string
}

type SortKey = 'newest' | 'oldest' | 'risk_desc' | 'risk_asc'

const RISK_CONFIG = {
    low: { color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-800/40', dot: 'bg-emerald-400', order: 0, label: 'Low' },
    medium: { color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-800/40', dot: 'bg-amber-400', order: 1, label: 'Medium' },
    high: { color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-800/40', dot: 'bg-orange-400', order: 2, label: 'High' },
    critical: { color: 'text-red-400', bg: 'bg-red-500/10 border-red-800/40', dot: 'bg-red-400', order: 3, label: 'Critical' },
}

const RISK_ORDER: Record<Approval['riskLevel'], number> = { low: 0, medium: 1, high: 2, critical: 3 }

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

const FILTER_KEYS = ['risk', 'decision'] as const

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
}

export default function ApprovalsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const [items, setItems] = useState<Approval[]>([])
    const [loading, setLoading] = useState(true)
    const [acting, setActing] = useState<Record<string, boolean>>({})
    const [bulkActing, setBulkActing] = useState(false)
    const [expanded, setExpanded] = useState<Set<string>>(new Set())

    // Controls
    const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null)

    // Filter hook
    const lf = useListFilter(FILTER_KEYS, 'risk_desc')
    const { search, filterValues, clearAll, sort } = lf

    const fetchApprovals = useCallback(async () => {
        if (!WS_ID) { setLoading(false); return }
        try {
            const res = await fetch(`${API_BASE}/api/v1/approvals?workspaceId=${WS_ID}`)
            if (!res.ok) { setLoading(false); return }
            const data = await res.json() as { items: Approval[] }
            setItems(data.items ?? [])
        } catch {
            // ignore
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => {
        void fetchApprovals()
        const iv = setInterval(() => void fetchApprovals(), 5000)
        return () => clearInterval(iv)
    }, [fetchApprovals])

    function showToast(ok: boolean, text: string) {
        setToast({ ok, text })
        setTimeout(() => setToast(null), 4000)
    }

    async function decide(id: string, action: 'approve' | 'reject') {
        setActing((prev) => ({ ...prev, [id]: true }))
        try {
            const res = await fetch(`${API_BASE}/api/v1/approvals/${id}/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: 'dashboard' }),
            })
            if (res.ok) {
                setItems((prev) => prev.filter((i) => i.id !== id))
                showToast(true, action === 'approve' ? 'Approved — agent will continue.' : 'Rejected — agent will abort.')
            } else {
                const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
                showToast(false, err.error?.message ?? `${action} failed`)
            }
        } catch {
            showToast(false, 'Network error')
        } finally {
            setActing((prev) => { const n = { ...prev }; delete n[id]; return n })
        }
    }

    const filtered = useMemo(() => {
        let out = [...items]

        if (filterValues.risk) {
            out = out.filter((i) => i.riskLevel === filterValues.risk)
        }

        if (filterValues.decision) {
            out = out.filter((i) => i.decision === filterValues.decision)
        }

        if (search.trim()) {
            const q = search.toLowerCase()
            out = out.filter(
                (i) =>
                    i.operation.toLowerCase().includes(q) ||
                    i.description.toLowerCase().includes(q) ||
                    i.taskId.toLowerCase().includes(q),
            )
        }

        out.sort((a, b) => {
            if (sort === 'newest') return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            if (sort === 'oldest') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            if (sort === 'risk_desc') return RISK_ORDER[b.riskLevel] - RISK_ORDER[a.riskLevel]
            return RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel]
        })

        return out
    }, [items, filterValues.risk, filterValues.decision, search, sort])

    async function bulkDecide(action: 'approve' | 'reject') {
        setBulkActing(true)
        const targets = filtered.map((i) => i.id)
        const results = await Promise.allSettled(
            targets.map((id) =>
                fetch(`${API_BASE}/api/v1/approvals/${id}/${action}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user: 'dashboard' }),
                }),
            ),
        )
        const ok = results.filter((r) => r.status === 'fulfilled' && (r.value as Response).ok).length
        setItems((prev) => prev.filter((i) => !targets.includes(i.id)))
        showToast(ok > 0, `${ok}/${targets.length} ${action === 'approve' ? 'approved' : 'rejected'}`)
        setBulkActing(false)
    }

    function toggleExpand(id: string) {
        setExpanded((prev) => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
        })
    }

    const availableRisks = useMemo(() => new Set(items.map((i) => i.riskLevel)), [items])
    const availableDecisions = useMemo(() => new Set(items.map((i) => i.decision)), [items])

    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'decision',
            label: 'Decision',
            options: [
                { value: 'pending', label: 'Pending', icon: <Clock className="h-3.5 w-3.5 text-amber-500 mr-1 shrink-0" />, dimmed: !availableDecisions.has('pending') },
                { value: 'approved', label: 'Approved', icon: <CheckCircle className="h-3.5 w-3.5 text-emerald-500 mr-1 shrink-0" />, dimmed: !availableDecisions.has('approved') },
                { value: 'rejected', label: 'Rejected', icon: <XCircle className="h-3.5 w-3.5 text-red-500 mr-1 shrink-0" />, dimmed: !availableDecisions.has('rejected') },
            ],
        },
        {
            key: 'risk',
            label: 'Risk Level',
            options: (['critical', 'high', 'medium', 'low'] as const).map((r) => {
                const cfg = RISK_CONFIG[r]
                return {
                    value: r,
                    label: cfg.label,
                    icon: <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot} mr-1 shrink-0`} />,
                    dimmed: !availableRisks.has(r),
                }
            }),
        },
    ], [availableRisks, availableDecisions])

    return (
        <div className="flex flex-col gap-4 max-w-4xl">

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <div className="flex items-center gap-2">
                        <h1 className="text-xl font-bold tracking-tight text-zinc-50">Approvals</h1>
                        {items.length > 0 && (
                            <span className="rounded-full bg-amber-500/15 border border-amber-700/40 px-2 py-0.5 text-xs font-semibold text-amber-400">
                                {items.length}
                            </span>
                        )}
                    </div>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        One-way door operations waiting for your decision before the agent proceeds.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void fetchApprovals()}
                        disabled={loading}
                        title="Refresh"
                        className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-40"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                        <span className="hidden sm:inline">Refresh</span>
                    </button>
                </div>
            </div>

            {/* Toast */}
            {toast && (
                <div className={`rounded-lg border px-4 py-2.5 text-sm ${toast.ok ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald-400' : 'border-red-800/50 bg-red-950/20 text-red-400'}`}>
                    {toast.text}
                </div>
            )}

            {/* Toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search operation, description, task ID…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Risk: high → low', value: 'risk_desc' },
                    { label: 'Risk: low → high', value: 'risk_asc' },
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                ]}
            />

            {/* Bulk actions */}
            {filtered.length > 1 && (
                <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2">
                    <span className="text-xs text-zinc-500 flex-1">
                        {filtered.length} {filterValues.risk || search ? 'matching' : 'pending'} approval{filtered.length !== 1 ? 's' : ''}
                    </span>
                    <button
                        onClick={() => void bulkDecide('reject')}
                        disabled={bulkActing}
                        className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:border-red-800/60 hover:text-red-400 disabled:opacity-50 transition-colors"
                    >
                        <Ban className="h-3 w-3" />
                        Reject all
                    </button>
                    <button
                        onClick={() => void bulkDecide('approve')}
                        disabled={bulkActing}
                        className="flex items-center gap-1.5 rounded-md bg-emerald-600/20 border border-emerald-700/40 px-3 py-1.5 text-xs font-medium text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50 transition-colors"
                    >
                        <CheckCheck className="h-3 w-3" />
                        Approve all
                    </button>
                </div>
            )}

            {/* List */}
            {loading ? (
                <div className="flex items-center justify-center py-16 text-sm text-zinc-600">
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Loading…
                </div>
            ) : items.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-sm text-zinc-600">
                    <CheckCircle className="h-8 w-8 text-zinc-800" />
                    <div className="text-center">
                        <p className="font-medium text-zinc-500">No pending approvals</p>
                        <p className="mt-0.5 text-xs text-zinc-700">The agent will ask for your review before performing irreversible operations.</p>
                    </div>
                </div>
            ) : filtered.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-12 text-center">
                    <p className="text-sm text-zinc-500">No results match your filters.</p>
                    <button onClick={clearAll} className="mt-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors mx-auto">
                        Clear filters
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {filtered.map((item) => {
                        const risk = RISK_CONFIG[item.riskLevel]
                        const isExpanded = expanded.has(item.id)
                        const isActing = !!acting[item.id]

                        return (
                            <div key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
                                {/* Row — always visible */}
                                <button
                                    onClick={() => toggleExpand(item.id)}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/30 transition-colors"
                                >
                                    {/* Risk dot */}
                                    <span className={`h-2 w-2 rounded-full shrink-0 ${risk.dot}`} title={risk.label} />

                                    {/* Operation */}
                                    <span className="text-sm font-mono font-medium text-zinc-200 flex-1 truncate">
                                        {item.operation}
                                    </span>

                                    {/* Risk label */}
                                    <span className={`hidden sm:inline-flex items-center gap-1 shrink-0 text-[10px] font-semibold ${risk.color}`}>
                                        <AlertTriangle className="h-3 w-3" />
                                        {risk.label}
                                    </span>

                                    {/* Task ID */}
                                    <span className="hidden md:block text-xs font-mono text-zinc-600 shrink-0">
                                        {item.taskId.slice(0, 8)}
                                    </span>

                                    {/* Age */}
                                    <span className="flex items-center gap-1 text-[11px] text-zinc-600 shrink-0">
                                        <Clock className="h-3 w-3" />
                                        {timeAgo(item.createdAt)}
                                    </span>

                                    {/* Quick actions — visible on hover via group */}
                                    <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                                        <button
                                            onClick={() => void decide(item.id, 'approve')}
                                            disabled={isActing}
                                            title="Approve"
                                            className="rounded-md bg-emerald-600/20 border border-emerald-700/40 px-2.5 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-600/30 disabled:opacity-50 transition-colors"
                                        >
                                            {isActing ? <RefreshCw className="h-3 w-3 animate-spin" /> : '✓'}
                                        </button>
                                        <button
                                            onClick={() => void decide(item.id, 'reject')}
                                            disabled={isActing}
                                            title="Reject"
                                            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs font-medium text-zinc-500 hover:border-red-700/60 hover:text-red-400 disabled:opacity-50 transition-colors"
                                        >
                                            ✕
                                        </button>
                                    </div>

                                    {/* Expand chevron */}
                                    {isExpanded
                                        ? <ChevronUp className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                                        : <ChevronDown className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                                    }
                                </button>

                                {/* Expanded detail */}
                                {isExpanded && (
                                    <div className={`border-t px-4 py-4 flex flex-col gap-4 ${risk.bg}`}>
                                        <div>
                                            <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">What the agent wants to do</p>
                                            <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{item.description}</p>
                                        </div>

                                        <div className="flex items-center gap-4">
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-0.5">Task</p>
                                                <a
                                                    href={`/tasks/${item.taskId}`}
                                                    className="text-xs font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    {item.taskId.slice(0, 8)}…
                                                </a>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-0.5">Risk</p>
                                                <span className={`text-xs font-semibold ${risk.color}`}>{risk.label}</span>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-0.5">Requested</p>
                                                <span className="text-xs text-zinc-500">{new Date(item.createdAt).toLocaleString()}</span>
                                            </div>
                                        </div>

                                        <div className="flex gap-2 pt-1 border-t border-zinc-800/60">
                                            <button
                                                onClick={() => void decide(item.id, 'approve')}
                                                disabled={isActing}
                                                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                                            >
                                                <CheckCircle className="h-3.5 w-3.5" />
                                                {isActing ? 'Processing…' : 'Approve'}
                                            </button>
                                            <button
                                                onClick={() => void decide(item.id, 'reject')}
                                                disabled={isActing}
                                                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:border-red-800/60 hover:text-red-400 disabled:opacity-50 transition-colors"
                                            >
                                                <XCircle className="h-3.5 w-3.5" />
                                                Reject
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}

            {/* Info panel */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-4">
                <div className="flex items-start gap-3">
                    <ShieldAlert className="h-4 w-4 text-zinc-500 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-xs font-medium text-zinc-400">What are one-way doors?</p>
                        <p className="mt-1 text-xs text-zinc-600 leading-relaxed">
                            These are operations the agent cannot undo — schema migrations, file deletions, external API calls with side effects, and force-pushes. The agent pauses and waits up to 30 minutes for your approval. Auto-rejected after 1 hour.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    )
}
