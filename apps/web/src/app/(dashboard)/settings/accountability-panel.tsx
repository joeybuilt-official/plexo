// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { CheckCircle, XCircle, FileText, Loader2, Play, TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

interface RSIProposal {
    id: string
    anomalyType: string
    hypothesis: string
    proposedChange: Record<string, unknown>
    risk: 'low' | 'medium' | 'high'
    status: 'pending' | 'approved' | 'rejected'
    createdAt: string
}

interface ShadowSummary {
    taskCount: number
    avgBaselineQuality: number | null
    avgShadowQuality: number | null
    qualityDelta: number | null
}

export function AccountabilityPanel() {
    const { workspaceId } = useWorkspace()
    const [proposals, setProposals] = useState<RSIProposal[]>([])
    const [loading, setLoading] = useState(false)
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [shadowResults, setShadowResults] = useState<Record<string, ShadowSummary>>({})
    const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const loadProposals = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/rsi/proposals`, { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json() as { items: RSIProposal[] }
                setProposals(data.items ?? [])
            }
        } catch {
            // Non-fatal
        } finally {
            setLoading(false)
        }
    }, [API_BASE, WS_ID])

    useEffect(() => { void loadProposals() }, [loadProposals])

    // Load shadow test results for approved proposals
    useEffect(() => {
        const approved = proposals.filter(p => p.status === 'approved')
        for (const p of approved) {
            if (shadowResults[p.id] !== undefined) continue
            fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/rsi/proposals/${p.id}/test-results`)
                .then(r => r.ok ? r.json() : null)
                .then((data: { summary: ShadowSummary } | null) => {
                    if (data?.summary) {
                        setShadowResults(prev => ({ ...prev, [p.id]: data.summary }))
                    }
                })
                .catch(() => { /* non-fatal */ })
        }
    }, [proposals, API_BASE, WS_ID, shadowResults])

    const handleAction = async (proposalId: string, action: 'approve' | 'reject') => {
        if (!WS_ID) return
        setActionLoading(proposalId)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/rsi/proposals/${proposalId}/${action}`, {
                method: 'POST',
            })
            if (res.ok) {
                const updated = await res.json() as RSIProposal
                if (updated) {
                    setProposals(prev => prev.map(p => p.id === proposalId ? { ...p, status: updated.status } : p))
                    // Kick off polling for shadow test results if approved
                    if (action === 'approve') {
                        setTimeout(() => {
                            fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/rsi/proposals/${proposalId}/test-results`)
                                .then(r => r.ok ? r.json() : null)
                                .then((data: { summary: ShadowSummary } | null) => {
                                    if (data?.summary) {
                                        setShadowResults(prev => ({ ...prev, [proposalId]: data.summary }))
                                    }
                                })
                                .catch(() => { /* non-fatal */ })
                        }, 3000) // 3s delay to let shadow test write
                    }
                } else {
                    void loadProposals()
                }
            }
        } catch {
            // handle err
        } finally {
            setActionLoading(null)
        }
    }

    if (loading && proposals.length === 0) {
        return (
            <div className="flex flex-col gap-6">
                <div>
                    <h2 className="text-lg font-bold text-zinc-50">Accountability</h2>
                    <p className="mt-0.5 text-sm text-text-muted">Real-Time Self-Inspection (RSI) Proposals.</p>
                </div>
                <div className="flex items-center justify-center p-12">
                    <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6">
            <div>
                <h2 className="text-lg font-bold text-zinc-50">Accountability (RSI)</h2>
                <p className="mt-0.5 text-sm text-text-muted">Review and approve self-improvement proposals generated by the agent&apos;s RSI system.</p>
            </div>

            <div className="flex flex-col gap-4">
                {proposals.length === 0 ? (
                    <div className="rounded-xl border border-border bg-surface-1/40 p-8 flex flex-col items-center gap-3 text-center">
                        <FileText className="h-8 w-8 text-text-muted" />
                        <div>
                            <p className="text-sm font-medium text-text-secondary">No proposals available</p>
                            <p className="text-xs text-text-muted mt-1">The RSI system monitors behavior and will propose improvements here.</p>
                        </div>
                    </div>
                ) : (
                    proposals.map(p => (
                        <div key={p.id} className="rounded-xl border border-border bg-surface-1/60 overflow-hidden">
                            <div className="flex items-start justify-between p-4 border-b border-border-subtle">
                                <div>
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-medium tracking-wider
                                            ${p.anomalyType === 'cost_spikes' ? 'text-red bg-red/10' :
                                              p.anomalyType === 'quality_degradation' ? 'text-yellow-400 bg-yellow-400/10' :
                                              'text-blue-400 bg-blue-400/10'}
                                        `}>
                                            {p.anomalyType.replace('_', ' ').toUpperCase()}
                                        </span>
                                        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-medium tracking-wider
                                            ${p.status === 'pending' ? 'text-azure bg-azure/10' :
                                              p.status === 'approved' ? 'text-azure bg-azure/10' :
                                              'text-text-secondary bg-surface-2'}
                                        `}>
                                            {p.status}
                                        </span>
                                    </div>
                                    <h4 className="text-sm font-medium text-text-primary">{p.hypothesis}</h4>
                                </div>
                                <div className="text-right shrink-0">
                                    <p className="text-[10px] text-text-muted">{new Date(p.createdAt).toLocaleDateString()}</p>
                                    <p className="text-[10px] text-text-muted mt-0.5 capitalize">Risk: {p.risk}</p>
                                </div>
                            </div>

                            <div className="p-4 bg-surface-1/40">
                                <p className="text-xs font-semibold text-text-secondary mb-2 uppercase tracking-wide">Proposed Protocol Change</p>
                                <pre className="text-xs text-azure font-mono overflow-auto bg-canvas p-3 rounded-lg border border-border/80">
                                    {JSON.stringify(p.proposedChange, null, 2)}
                                </pre>

                                {/* Shadow test results — shown after approve */}
                                {p.status === 'approved' && shadowResults[p.id] && (() => {
                                    const sr = shadowResults[p.id]!
                                    const delta = sr.qualityDelta
                                    const DeltaIcon = delta === null ? Minus : delta > 0 ? TrendingUp : TrendingDown
                                    const deltaColor = delta === null ? 'text-text-muted' : delta > 0 ? 'text-azure' : 'text-red'
                                    return (
                                        <div className="mt-4 pt-4 border-t border-border-subtle">
                                            <p className="text-xs font-semibold text-text-secondary mb-3 uppercase tracking-wide flex items-center gap-1.5">
                                                <CheckCircle className="h-3.5 w-3.5 text-azure" />
                                                Shadow Test Results ({sr.taskCount} tasks)
                                            </p>
                                            <div className="grid grid-cols-3 gap-3">
                                                <div className="bg-canvas rounded-lg p-3 border border-border/60">
                                                    <p className="text-[10px] text-text-muted mb-1">Baseline Quality</p>
                                                    <p className="text-sm font-mono font-semibold text-text-primary">
                                                        {sr.avgBaselineQuality !== null ? (sr.avgBaselineQuality * 100).toFixed(1) + '%' : '—'}
                                                    </p>
                                                </div>
                                                <div className="bg-canvas rounded-lg p-3 border border-border/60">
                                                    <p className="text-[10px] text-text-muted mb-1">Shadow Quality</p>
                                                    <p className="text-sm font-mono font-semibold text-text-primary">
                                                        {sr.avgShadowQuality !== null ? (sr.avgShadowQuality * 100).toFixed(1) + '%' : '—'}
                                                    </p>
                                                </div>
                                                <div className="bg-canvas rounded-lg p-3 border border-border/60">
                                                    <p className="text-[10px] text-text-muted mb-1">Quality Δ</p>
                                                    <p className={`text-sm font-mono font-semibold flex items-center gap-1 ${deltaColor}`}>
                                                        <DeltaIcon className="h-3.5 w-3.5" />
                                                        {delta !== null ? ((delta > 0 ? '+' : '') + (delta * 100).toFixed(1) + '%') : '—'}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                    )
                                })()}

                                {p.status === 'pending' && (
                                    <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border-subtle">
                                        <button
                                            type="button"
                                            onClick={() => void handleAction(p.id, 'approve')}
                                            disabled={!!actionLoading}
                                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-azure-600/20 hover:bg-azure-600/30 text-azure px-3 py-2 text-xs font-medium border border-azure/30 transition-colors disabled:opacity-50"
                                        >
                                            {actionLoading === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                                            Run Shadow Mode
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void handleAction(p.id, 'reject')}
                                            disabled={!!actionLoading}
                                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-surface-2 hover:bg-zinc-700 text-text-secondary px-3 py-2 text-xs font-medium border border-border transition-colors disabled:opacity-50"
                                        >
                                            <XCircle className="h-3.5 w-3.5" />
                                            Dismiss Fluke
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    )
}
