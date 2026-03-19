'use client'

import { useState, useEffect, useCallback } from 'react'
import { Sparkles, Check, X, ShieldAlert, Activity, TrendingDown, Target, BrainCircuit } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { toast } from 'sonner'

interface RSIProposal {
    id: string
    workspaceId: string
    anomalyType: 'quality_degradation' | 'confidence_skew' | 'cost_spikes'
    hypothesis: string
    proposedChange: Record<string, unknown>
    risk: 'low' | 'medium' | 'high'
    status: 'pending' | 'approved' | 'rejected'
    createdAt: string
}

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

export function RSIProposalsPanel() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const WS_ID = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [proposals, setProposals] = useState<RSIProposal[]>([])
    const [loaded, setLoaded] = useState(false)
    const [actioningId, setActioningId] = useState<string | null>(null)

    const fetchProposals = useCallback(async () => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/rsi/proposals`)
            if (res.ok) {
                const data = await res.json() as { items: RSIProposal[] }
                setProposals(data.items.filter(p => p.status === 'pending'))
            }
        } catch {
            // non-fatal
        } finally {
            setLoaded(true)
        }
    }, [WS_ID])

    useEffect(() => {
        void fetchProposals()
        const t = setInterval(() => void fetchProposals(), 30_000)
        return () => clearInterval(t)
    }, [fetchProposals])

    const handleAction = async (id: string, action: 'approve' | 'reject') => {
        setActioningId(id)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/rsi/proposals/${id}/${action}`, {
                method: 'POST'
            })
            if (!res.ok) throw new Error('Failed to update proposal')
            
            toast.success(`Proposal ${action}d successfully.`)
            setProposals(prev => prev.filter(p => p.id !== id))
        } catch (err: unknown) {
            toast.error('Action failed', { description: err instanceof Error ? err.message : 'Unknown error' })
        } finally {
            setActioningId(null)
        }
    }

    if (!loaded) return null
    if (proposals.length === 0) return null

    const getAnomalyConfig = (type: string) => {
        switch (type) {
            case 'quality_degradation': return { icon: TrendingDown, color: 'text-amber', bg: 'bg-amber-dim' }
            case 'confidence_skew': return { icon: Target, color: 'text-blue-500', bg: 'bg-blue-500/10' }
            case 'cost_spikes': return { icon: Activity, color: 'text-red', bg: 'bg-rose-500/10' }
            default: return { icon: BrainCircuit, color: 'text-violet-500', bg: 'bg-violet-500/10' }
        }
    }

    return (
        <div className="rounded-xl border border-violet-500/20  from-zinc-900/60 to-zinc-950/60 backdrop-blur-sm shadow-xl overflow-hidden mb-6">
            <div className="flex items-center justify-between border-b border-violet-500/10 px-4 py-3 bg-violet-500/5">
                <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-violet-400" />
                    <h3 className="text-[13px] font-semibold text-violet-300">Intelligent Insights (RSI)</h3>
                </div>
                <span className="text-[11px] font-medium text-violet-400 bg-violet-500/10 ring-1 ring-inset ring-violet-500/20 px-2.5 py-0.5 rounded-full">
                    {proposals.length} proposal{proposals.length !== 1 ? 's' : ''}
                </span>
            </div>
            
            <div className="p-4 grid gap-4">
                {proposals.map(proposal => {
                    const { icon: Icon, color, bg } = getAnomalyConfig(proposal.anomalyType)
                    const isActioning = actioningId === proposal.id

                    return (
                        <div
                            key={proposal.id}
                            className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-4 rounded-lg border border-border/80 bg-surface-1/50 shadow-sm animate-in fade-in slide-in-from-bottom-2 duration-300"
                        >
                                <div className="flex items-start gap-4 flex-1">
                                    <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${bg} ${color}`}>
                                        <Icon className="w-4 h-4" />
                                    </div>
                                    <div>
                                        <div className="flex items-center gap-2 mb-1">
                                            <span className="text-xs font-semibold text-text-primary capitalize tracking-wide">{proposal.anomalyType.replace('_', ' ')}</span>
                                            {proposal.risk === 'high' && (
                                                <span className="flex items-center gap-1 text-[10px] uppercase font-bold text-rose-400 bg-rose-500/10 px-1.5 rounded">
                                                    <ShieldAlert className="w-3 h-3" /> High Risk
                                                </span>
                                            )}
                                        </div>
                                        <p className="text-sm text-text-secondary leading-relaxed max-w-2xl">{proposal.hypothesis}</p>
                                        
                                        <div className="mt-3 flex items-center gap-2 text-xs font-mono text-text-muted bg-canvas p-2 rounded-md border border-border">
                                            <span className="text-violet-400">Proposed Action:</span>
                                            <span className="text-text-secondary">{JSON.stringify(proposal.proposedChange)}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0 md:ml-4">
                                    <button
                                        disabled={isActioning}
                                        onClick={() => handleAction(proposal.id, 'reject')}
                                        className="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium text-text-secondary hover:text-rose-400 hover:bg-rose-500/10 border border-transparent transition-colors disabled:opacity-50"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                        Discard
                                    </button>
                                    <button
                                        disabled={isActioning}
                                        onClick={() => handleAction(proposal.id, 'approve')}
                                        className="flex-1 md:flex-none flex items-center justify-center gap-1.5 px-4 py-2 rounded-md text-xs font-medium text-violet-100 bg-violet-600 hover:bg-violet-500 transition-colors shadow-sm disabled:opacity-50"
                                    >
                                        <Check className="w-3.5 h-3.5" />
                                        Approve Fix
                                    </button>
                                </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
