// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    FileText,
    RefreshCw,
    AlertCircle,
    ChevronDown,
    ChevronUp,
    Info,
    CheckCircle,
    XCircle,
    Ban,
    Cpu,
    Bot,
    Zap,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface AuditEntry {
    id: string
    workspaceId: string
    extensionId: string
    agentId?: string
    sessionId: string
    action: string
    target: string
    payloadHash: string
    outcome: 'success' | 'failure' | 'denied'
    modelContext?: {
        modelId?: string
        modelProvider?: string
        isLocal?: boolean
        contextWindowUsed?: number
    }
    escalationOutcome?: string
    createdAt: string
}

const OUTCOME_CONFIG = {
    success: { icon: CheckCircle, color: 'text-azure', bg: 'bg-azure/10 border-azure-800/30', label: 'Success' },
    failure: { icon: XCircle, color: 'text-red', bg: 'bg-red-950/20 border-red-800/30', label: 'Failure' },
    denied: { icon: Ban, color: 'text-amber', bg: 'bg-amber-950/20 border-amber-800/30', label: 'Denied' },
}

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

export default function AuditPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [items, setItems] = useState<AuditEntry[]>([])
    const [total, setTotal] = useState(0)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [expanded, setExpanded] = useState<Set<string>>(new Set())

    const lf = useListFilter(['action', 'outcome'], 'newest')
    const { search, filterValues, clearAll, sort } = lf

    // Read agentId from URL params for deep-link from agent card
    const urlAgentId = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('agentId')
        : null

    const fetchAudit = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        setError(null)
        try {
            const params = new URLSearchParams({ workspaceId: WS_ID, limit: '100' })
            if (filterValues.action) params.set('action', filterValues.action)
            if (filterValues.outcome) params.set('outcome', filterValues.outcome)
            if (urlAgentId) params.set('agentId', urlAgentId)
            const res = await fetch(`${API_BASE}/api/v1/kapsel-audit?${params}`)
            if (!res.ok) {
                if (res.status === 404) {
                    setItems([])
                    setTotal(0)
                    return
                }
                throw new Error(`HTTP ${res.status}`)
            }
            const data = await res.json() as { items: AuditEntry[]; total: number }
            setItems(data.items ?? [])
            setTotal(data.total ?? 0)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load audit trail')
        } finally {
            setLoading(false)
        }
    }, [WS_ID, filterValues.action, filterValues.outcome, urlAgentId])

    useEffect(() => { void fetchAudit() }, [fetchAudit])

    const filtered = useMemo(() => {
        let out = [...items]
        if (search.trim()) {
            const q = search.toLowerCase()
            out = out.filter(e =>
                e.extensionId.toLowerCase().includes(q) ||
                e.action.toLowerCase().includes(q) ||
                e.target.toLowerCase().includes(q) ||
                e.agentId?.toLowerCase().includes(q)
            )
        }
        out.sort((a, b) => {
            if (sort === 'oldest') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })
        return out
    }, [items, search, sort])

    function toggleExpand(id: string) {
        setExpanded((prev) => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
        })
    }

    return (
        <div className="flex flex-col gap-4 max-w-4xl">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-zinc-50">Audit Trail</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        Immutable ledger of extension and agent actions
                    </p>
                </div>
                <button
                    onClick={() => void fetchAudit()}
                    disabled={loading}
                    title="Refresh"
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">Refresh</span>
                </button>
            </div>

            {urlAgentId && (
                <div className="rounded-lg border border-azure-800/30 bg-azure/10 px-3 py-2 flex items-center gap-2 text-xs text-azure">
                    <Bot className="h-3.5 w-3.5 shrink-0" />
                    Filtered to agent: <span className="font-mono font-medium">{urlAgentId}</span>
                    <a href="/audit" className="ml-auto hover:underline">Clear filter</a>
                </div>
            )}

            <div className="rounded-xl border border-azure-800/30 bg-azure/10 px-4 py-3 flex items-start gap-3">
                <Info className="h-4 w-4 text-azure shrink-0 mt-0.5" />
                <p className="text-xs text-azure/70">
                    Every action taken by extensions and agents is recorded here — immutable and verifiable.
                    Entries include the action type, target, outcome, and which LLM model produced the decision.
                </p>
            </div>

            {error && (
                <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 flex items-center gap-2 text-xs text-red">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                </div>
            )}

            <ListToolbar
                hook={lf}
                placeholder="Search extension, action, target..."
                dimensions={[
                    {
                        key: 'action',
                        label: 'Action',
                        options: [
                            { value: 'function_invoked', label: 'Function Invoked' },
                            { value: 'memory_read', label: 'Memory Read' },
                            { value: 'memory_write', label: 'Memory Write' },
                            { value: 'channel_send', label: 'Channel Send' },
                            { value: 'entity_created', label: 'Entity Created' },
                            { value: 'external_request', label: 'External Request' },
                            { value: 'escalation_triggered', label: 'Escalation' },
                        ],
                    },
                    {
                        key: 'outcome',
                        label: 'Outcome',
                        options: [
                            { value: 'success', label: 'Success' },
                            { value: 'failure', label: 'Failure' },
                            { value: 'denied', label: 'Denied' },
                        ],
                    },
                ]}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                ]}
            />

            {!loading && total > 0 && (
                <p className="text-xs text-text-muted">
                    Showing <span className="text-text-secondary font-medium">{filtered.length}</span> of {total} entries
                </p>
            )}

            {loading ? (
                <div className="flex items-center justify-center py-16 text-sm text-text-muted">
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    Loading…
                </div>
            ) : items.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <FileText className="h-10 w-10 text-zinc-700" />
                    <div className="text-center">
                        <p className="text-sm font-medium text-text-muted">No audit entries yet</p>
                        <p className="text-xs text-text-muted mt-1">
                            Actions will be logged here as extensions and agents operate.
                        </p>
                    </div>
                </div>
            ) : filtered.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-12 text-center">
                    <p className="text-sm text-text-muted">No results match your filters.</p>
                    <button onClick={clearAll} className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto">
                        Clear filters
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-1">
                    {filtered.map((entry) => {
                        const cfg = OUTCOME_CONFIG[entry.outcome] ?? OUTCOME_CONFIG.success
                        const Icon = cfg.icon
                        const isExpanded = expanded.has(entry.id)

                        return (
                            <div key={entry.id} className="rounded-xl border border-border bg-surface-1/60 overflow-hidden">
                                <button
                                    onClick={() => toggleExpand(entry.id)}
                                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2/30 transition-colors"
                                >
                                    <Icon className={`h-3.5 w-3.5 shrink-0 ${cfg.color}`} />
                                    <span className="text-xs font-mono text-text-secondary truncate flex-1">{entry.action}</span>
                                    <span className="text-xs text-text-muted truncate max-w-[200px]">{entry.target}</span>
                                    {entry.agentId && (
                                        <span className="hidden sm:flex items-center gap-1 text-[10px] text-azure shrink-0">
                                            <Bot className="h-3 w-3" />{entry.agentId.split('/').pop()}
                                        </span>
                                    )}
                                    <span className="hidden md:block text-[10px] font-mono text-text-muted shrink-0">{entry.extensionId.split('/').pop()}</span>
                                    <span className="text-[10px] text-text-muted shrink-0">{timeAgo(entry.createdAt)}</span>
                                    {isExpanded
                                        ? <ChevronUp className="h-3 w-3 text-text-muted shrink-0" />
                                        : <ChevronDown className="h-3 w-3 text-text-muted shrink-0" />
                                    }
                                </button>

                                {isExpanded && (
                                    <div className="border-t border-border px-4 py-3 flex flex-col gap-3 text-xs">
                                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">Extension</p>
                                                <p className="font-mono text-text-secondary">{entry.extensionId}</p>
                                            </div>
                                            {entry.agentId && (
                                                <div>
                                                    <p className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">Agent</p>
                                                    <p className="font-mono text-text-secondary">{entry.agentId}</p>
                                                </div>
                                            )}
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">Session</p>
                                                <p className="font-mono text-text-muted">{entry.sessionId.slice(0, 8)}…</p>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">Payload Hash</p>
                                                <p className="font-mono text-text-muted">{entry.payloadHash.slice(0, 16)}…</p>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">Outcome</p>
                                                <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${cfg.bg} ${cfg.color}`}>
                                                    {cfg.label}
                                                </span>
                                            </div>
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-text-muted mb-0.5">Timestamp</p>
                                                <p className="text-text-muted">{new Date(entry.createdAt).toLocaleString()}</p>
                                            </div>
                                        </div>

                                        {entry.modelContext && (
                                            <div>
                                                <p className="text-[10px] uppercase tracking-wide text-text-muted mb-1 flex items-center gap-1">
                                                    <Cpu className="h-3 w-3" /> Model Context
                                                </p>
                                                <div className="flex flex-wrap gap-2 text-text-muted">
                                                    {entry.modelContext.modelId && (
                                                        <span>Model: <span className="text-text-secondary font-medium">{entry.modelContext.modelId}</span></span>
                                                    )}
                                                    {entry.modelContext.modelProvider && (
                                                        <span>Provider: <span className="text-text-secondary">{entry.modelContext.modelProvider}</span></span>
                                                    )}
                                                    {entry.modelContext.isLocal !== undefined && (
                                                        <span>{entry.modelContext.isLocal ? 'Local' : 'Cloud'}</span>
                                                    )}
                                                    {entry.modelContext.contextWindowUsed && (
                                                        <span>Tokens: <span className="text-text-secondary">{entry.modelContext.contextWindowUsed.toLocaleString()}</span></span>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {entry.escalationOutcome && (
                                            <div className="flex items-center gap-2">
                                                <p className="text-[10px] uppercase tracking-wide text-text-muted">Escalation:</p>
                                                <span className="rounded border border-emerald-700/40 bg-emerald-950/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                                                    {entry.escalationOutcome}
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
