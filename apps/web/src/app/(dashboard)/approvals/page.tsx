'use client'

import { useState, useEffect, useCallback } from 'react'
import { ShieldAlert, CheckCircle, XCircle, Clock, RefreshCw, AlertTriangle } from 'lucide-react'

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

const RISK_CONFIG = {
    low: { color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-800/40', label: 'Low risk' },
    medium: { color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-800/40', label: 'Medium risk' },
    high: { color: 'text-orange-400', bg: 'bg-orange-500/10 border-orange-800/40', label: 'High risk' },
    critical: { color: 'text-red-400', bg: 'bg-red-500/10 border-red-800/40', label: 'Critical' },
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const WS_ID = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
}

export default function ApprovalsPage() {
    const [items, setItems] = useState<Approval[]>([])
    const [loading, setLoading] = useState(true)
    const [acting, setActing] = useState<string | null>(null)
    const [message, setMessage] = useState<{ id: string; ok: boolean; text: string } | null>(null)

    const fetchApprovals = useCallback(async () => {
        if (!WS_ID) { setLoading(false); return }
        try {
            const res = await fetch(`${API_BASE}/api/approvals?workspaceId=${WS_ID}`)
            if (!res.ok) { setLoading(false); return }
            const data = await res.json() as { items: Approval[] }
            setItems(data.items ?? [])
        } catch {
            // ignore
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        void fetchApprovals()
        const iv = setInterval(() => void fetchApprovals(), 5000)
        return () => clearInterval(iv)
    }, [fetchApprovals])

    async function decide(id: string, action: 'approve' | 'reject') {
        setActing(id)
        setMessage(null)
        try {
            const res = await fetch(`${API_BASE}/api/approvals/${id}/${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user: 'dashboard' }),
            })
            if (res.ok) {
                setItems((prev) => prev.filter((i) => i.id !== id))
                setMessage({ id, ok: true, text: action === 'approve' ? 'Approved — agent will continue.' : 'Rejected — agent will abort the operation.' })
            } else {
                const err = await res.json().catch(() => ({})) as { error?: { message?: string } }
                setMessage({ id, ok: false, text: err.error?.message ?? `${action} failed` })
            }
        } catch {
            setMessage({ id, ok: false, text: 'Network error' })
        } finally {
            setActing(null)
        }
    }

    return (
        <div className="flex flex-col gap-6 max-w-3xl">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
                    <p className="mt-1 text-sm text-zinc-500">
                        One-way door operations waiting for your decision before the agent proceeds.
                    </p>
                </div>
                <button
                    onClick={() => void fetchApprovals()}
                    disabled={loading}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                </button>
            </div>

            {/* Global message */}
            {message && (
                <div className={`rounded-lg border px-4 py-3 text-sm ${message.ok ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald-400' : 'border-red-800/50 bg-red-950/20 text-red-400'}`}>
                    {message.text}
                </div>
            )}

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
            ) : (
                <div className="flex flex-col gap-3">
                    {items.map((item) => {
                        const risk = RISK_CONFIG[item.riskLevel]
                        return (
                            <div key={item.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 overflow-hidden">
                                {/* Risk banner */}
                                <div className={`flex items-center gap-2 border-b px-4 py-2 ${risk.bg}`}>
                                    <AlertTriangle className={`h-3.5 w-3.5 shrink-0 ${risk.color}`} />
                                    <span className={`text-xs font-semibold ${risk.color}`}>{risk.label} — one-way door operation</span>
                                    <span className="ml-auto text-[10px] text-zinc-600 flex items-center gap-1">
                                        <Clock className="h-3 w-3" />{timeAgo(item.createdAt)}
                                    </span>
                                </div>

                                <div className="p-4 flex flex-col gap-4">
                                    {/* Operation */}
                                    <div>
                                        <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">Operation</p>
                                        <p className="text-sm font-mono font-semibold text-zinc-100">{item.operation}</p>
                                    </div>

                                    {/* Description */}
                                    <div>
                                        <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">What the agent wants to do</p>
                                        <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{item.description}</p>
                                    </div>

                                    {/* Task reference */}
                                    <div className="flex items-center gap-2">
                                        <p className="text-[10px] uppercase tracking-wide text-zinc-600">Task</p>
                                        <a
                                            href={`/tasks/${item.taskId}`}
                                            className="text-xs font-mono text-indigo-400 hover:text-indigo-300 transition-colors"
                                        >
                                            {item.taskId.slice(0, 8)}…
                                        </a>
                                    </div>

                                    {/* Actions */}
                                    <div className="flex gap-2 pt-1 border-t border-zinc-800">
                                        <button
                                            onClick={() => void decide(item.id, 'approve')}
                                            disabled={acting === item.id}
                                            className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
                                        >
                                            <CheckCircle className="h-3.5 w-3.5" />
                                            {acting === item.id ? 'Processing…' : 'Approve'}
                                        </button>
                                        <button
                                            onClick={() => void decide(item.id, 'reject')}
                                            disabled={acting === item.id}
                                            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-300 hover:border-red-800/60 hover:text-red-400 disabled:opacity-50 transition-colors"
                                        >
                                            <XCircle className="h-3.5 w-3.5" />
                                            Reject
                                        </button>
                                    </div>
                                </div>
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
