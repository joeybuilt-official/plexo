// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import {
    Bot,
    RefreshCw,
    AlertCircle,
    ChevronDown,
    ChevronRight,
    ToggleLeft,
    ToggleRight,
    Info,
    Shield,
    Globe,
    Cpu,
    ShieldAlert,
    Zap,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface ExtensionManifest {
    name: string
    version: string
    description?: string
    type: string
    fabric: string
    capabilities?: string[]
    trust?: string
    dataResidency?: { sendsDataExternally: boolean; externalDestinations?: Array<{ host: string; purpose: string }> }
    modelRequirements?: {
        minimumContextWindow?: number
        requiresFunctionCalling?: boolean
        localModelAcceptable?: boolean
        preferredProviders?: string[]
    }
    escalation?: {
        irreversibleActions?: string[]
        requestsStandingApprovals?: boolean
    }
    agentHints?: {
        taskTypes?: string[]
        minConfidence?: number
    }
}

interface Plugin {
    id: string
    name: string
    version: string
    type: string
    fabricVersion: string
    enabled: boolean
    installedAt: string
    manifest: ExtensionManifest | null
    settings: Record<string, unknown>
}

function AgentCard({ agent, onToggle }: { agent: Plugin; onToggle: (id: string, enabled: boolean) => Promise<void> }) {
    const [expanded, setExpanded] = useState(false)
    const [toggling, setToggling] = useState(false)
    const manifest = agent.manifest

    async function handleToggle() {
        setToggling(true)
        try { await onToggle(agent.id, !agent.enabled) } finally { setToggling(false) }
    }

    return (
        <div className={`rounded-xl border transition-all ${agent.enabled
            ? 'border-border/60 bg-surface-1/60'
            : 'border-border/40 bg-surface-1/20 opacity-70'
            }`}>
            <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                onClick={() => setExpanded((e) => !e)}
            >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${agent.enabled ? 'bg-azure/20' : 'bg-surface-2'}`}>
                    <Bot className={`h-4.5 w-4.5 ${agent.enabled ? 'text-azure' : 'text-text-muted'}`} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">{agent.name}</span>
                        <span className="text-[10px] font-mono text-text-muted shrink-0">v{agent.version}</span>
                        <span className="text-[10px] rounded border border-azure-800/30 bg-azure/10 px-1.5 py-0.5 text-azure font-medium shrink-0">Agent</span>
                        {manifest?.trust && (
                            <span className="text-[10px] rounded border border-border px-1.5 py-0.5 text-text-muted shrink-0">{manifest.trust}</span>
                        )}
                    </div>
                    {manifest?.description && (
                        <p className="text-xs text-text-muted truncate">{manifest.description}</p>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={(e) => { e.stopPropagation(); void handleToggle() }}
                        disabled={toggling}
                        className="flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs transition-colors hover:border-zinc-600 disabled:opacity-40"
                    >
                        {toggling ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin text-text-muted" />
                        ) : agent.enabled ? (
                            <><ToggleRight className="h-4 w-4 text-azure" /><span className="text-azure">Enabled</span></>
                        ) : (
                            <><ToggleLeft className="h-4 w-4 text-text-muted" /><span className="text-text-muted">Disabled</span></>
                        )}
                    </button>
                    {expanded
                        ? <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
                        : <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                    }
                </div>
            </div>

            {expanded && (
                <div className="border-t border-border px-4 py-3 flex flex-col gap-3">
                    {/* Capabilities */}
                    {(manifest?.capabilities ?? []).length > 0 && (
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">Capabilities</p>
                            <div className="flex flex-wrap gap-1">
                                {manifest!.capabilities!.map((c) => (
                                    <span key={c} className="rounded border border-amber-800/40 bg-amber-950/20 px-2 py-0.5 text-[10px] font-mono text-amber">{c}</span>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Model Requirements (§24) */}
                    {manifest?.modelRequirements && (
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1.5 flex items-center gap-1">
                                <Cpu className="h-3 w-3" /> Model Requirements
                            </p>
                            <div className="flex flex-wrap gap-2 text-[11px] text-text-muted">
                                {manifest.modelRequirements.minimumContextWindow && (
                                    <span>Min context: <span className="text-text-secondary font-medium">{(manifest.modelRequirements.minimumContextWindow / 1000).toFixed(0)}k</span></span>
                                )}
                                {manifest.modelRequirements.requiresFunctionCalling && (
                                    <span className="text-text-secondary">Requires function calling</span>
                                )}
                                {manifest.modelRequirements.localModelAcceptable !== undefined && (
                                    <span>Local model: <span className="text-text-secondary font-medium">{manifest.modelRequirements.localModelAcceptable ? 'OK' : 'No'}</span></span>
                                )}
                                {manifest.modelRequirements.preferredProviders && (
                                    <span>Preferred: <span className="text-text-secondary font-medium">{manifest.modelRequirements.preferredProviders.join(', ')}</span></span>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Escalation (§23) */}
                    {manifest?.escalation && (
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1.5 flex items-center gap-1">
                                <ShieldAlert className="h-3 w-3" /> Escalation
                            </p>
                            {manifest.escalation.irreversibleActions && manifest.escalation.irreversibleActions.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {manifest.escalation.irreversibleActions.map((a) => (
                                        <span key={a} className="rounded border border-red-800/40 bg-red-950/20 px-2 py-0.5 text-[10px] font-mono text-red">{a}</span>
                                    ))}
                                </div>
                            )}
                            {manifest.escalation.requestsStandingApprovals && (
                                <p className="text-[11px] text-text-muted mt-1">Requests standing approval capability</p>
                            )}
                        </div>
                    )}

                    {/* Data Residency (§19) */}
                    {manifest?.dataResidency && (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            <Globe className="h-3 w-3" />
                            <span>{manifest.dataResidency.sendsDataExternally ? 'Sends data externally' : 'Local only'}</span>
                        </div>
                    )}

                    {/* Agent hints */}
                    {manifest?.agentHints?.taskTypes && manifest.agentHints.taskTypes.length > 0 && (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            <Zap className="h-3 w-3" />
                            <span>Task types: {manifest.agentHints.taskTypes.join(', ')}</span>
                        </div>
                    )}

                    <div className="flex items-center gap-4 text-[11px] text-text-muted">
                        <span>Installed {new Date(agent.installedAt).toLocaleDateString()}</span>
                        <span>Fabric {agent.fabricVersion}</span>
                        <a href={`/audit?agentId=${encodeURIComponent(agent.name)}`} className="text-azure hover:underline">
                            View audit trail →
                        </a>
                    </div>
                </div>
            )}
        </div>
    )
}

export default function AgentsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [plugins, setPlugins] = useState<Plugin[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const lf = useListFilter(['status'], 'name_asc')
    const { search, filterValues, clearAll } = lf

    const fetchAgents = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/extensions?workspaceId=${WS_ID}&type=agent`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json() as { items: Plugin[] }
            setPlugins(data.items)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load agents')
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchAgents() }, [fetchAgents])

    async function handleToggle(id: string, enabled: boolean) {
        const res = await fetch(`${API_BASE}/api/v1/extensions/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        })
        if (res.ok) {
            setPlugins((prev) => prev.map((p) => p.id === id ? { ...p, enabled } : p))
        }
    }

    const filtered = plugins.filter((p) => {
        if (filterValues.status === 'enabled' && !p.enabled) return false
        if (filterValues.status === 'disabled' && p.enabled) return false
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return p.name.toLowerCase().includes(q) || p.manifest?.description?.toLowerCase().includes(q)
    }).sort((a, b) => {
        if (lf.sort === 'name_desc') return b.name.localeCompare(a.name)
        return a.name.localeCompare(b.name)
    })

    return (
        <div className="flex flex-col gap-6 max-w-4xl">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-zinc-50">Agents</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        Autonomous actors that orchestrate extensions to accomplish work
                    </p>
                </div>
                <button
                    onClick={() => void fetchAgents()}
                    disabled={loading}
                    title="Refresh"
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">Refresh</span>
                </button>
            </div>

            <div className="rounded-xl border border-azure-800/30 bg-azure/20 px-4 py-3 flex items-start gap-3">
                <Info className="h-4 w-4 text-azure shrink-0 mt-0.5" />
                <div>
                    <p className="text-xs font-medium text-azure mb-0.5">Plexo Fabric Agents</p>
                    <p className="text-xs text-azure/70">
                        Agents are autonomous actors with their own planning loop and identity. Each Agent orchestrates Extensions to accomplish work — it picks up tools the way a person picks up appliances.
                        Agents are not extensions. They have their own escalation contracts, model requirements, and audit trails.
                    </p>
                </div>
            </div>

            {error && (
                <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 flex items-center gap-2 text-xs text-red">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                </div>
            )}

            <ListToolbar
                hook={lf}
                placeholder="Search agents..."
                dimensions={[
                    {
                        key: 'status',
                        label: 'Status',
                        options: [
                            { value: 'enabled', label: 'Enabled' },
                            { value: 'disabled', label: 'Disabled' },
                        ],
                    },
                ]}
                sortOptions={[
                    { label: 'Name: A → Z', value: 'name_asc' },
                    { label: 'Name: Z → A', value: 'name_desc' },
                ]}
            />

            {loading ? (
                <div className="flex items-center justify-center py-16">
                    <RefreshCw className="h-5 w-5 text-text-muted animate-spin" />
                </div>
            ) : plugins.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <Bot className="h-10 w-10 text-zinc-700" />
                    <div className="text-center">
                        <p className="text-sm font-medium text-text-muted">No agents installed</p>
                        <p className="text-xs text-text-muted mt-1">
                            Install agents from the <a href="/marketplace" className="text-azure hover:underline">Marketplace</a> to add autonomous capabilities.
                        </p>
                    </div>
                </div>
            ) : filtered.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-12 text-center">
                    <p className="text-sm text-text-muted">No results match your filters.</p>
                    <button onClick={clearAll} className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto">
                        Clear search
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-text-muted">{plugins.filter((p) => p.enabled).length} / {plugins.length} enabled</p>
                    </div>
                    {filtered.map((a) => (
                        <AgentCard key={a.id} agent={a} onToggle={handleToggle} />
                    ))}
                </div>
            )}
        </div>
    )
}
