// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import { useWorkspace } from '@web/context/workspace'
import {
    BrainCircuit,
    Cpu,
    Plug,
    Zap,
    Wrench,
    ShieldAlert,
    TrendingUp,
    RefreshCw,
    CheckCircle2,
    AlertCircle,
    Circle,
    ChevronDown,
    ChevronRight,
    Activity,
    DollarSign,
    Clock,
    Server,
    MemoryStick,
} from 'lucide-react'
import Link from 'next/link'

// ── Types — mirror IntrospectionSnapshot from packages/agent ─────────────────

interface ProviderSnapshot {
    key: string
    name: string
    model: string
    status: 'primary' | 'fallback' | 'configured' | 'unconfigured'
    enabled: boolean
    modalities: string[]
    missing: string[]
}

interface ConnectionSnapshot {
    registryId: string
    name: string
    status: 'active' | 'error' | 'expired' | 'pending'
    tools: string[]
    capabilities: string[]
}

interface ExtensionSnapshot {
    name: string
    version: string
    enabled: boolean
    tools: string[]
}

interface MemorySnapshot {
    totalEntries: number
    byType: Record<string, number>
    embeddingCoveragePercent: number
    recentPatterns: string[]
    pendingImprovements: number
}

interface CostSnapshot {
    weeklyUsedUsd: number
    weeklyCeilingUsd: number
    percentUsed: number
    taskCount7d: number
    avgQuality7d: number | null
    totalTokens7d: number
}

interface SafetySnapshot {
    maxConsecutiveToolCalls: number
    maxWallClockMs: number
    maxWallClockHuman: string
    maxRetries: number
    noForcePush: boolean
    noDeletionWithoutConfirmation: boolean
    noCredentialsInLogs: boolean
}

interface BuildInfo {
    version: string
    buildTime: string | null
    nodeVersion: string
    uptimeSeconds: number
    memoryMb: number
    pid: number
}

interface IntrospectionSnapshot {
    workspaceId: string
    agentName: string
    agentPersona: string | null
    agentTagline: string | null
    activeProvider: string | null
    activeModel: string | null
    primaryProvider: string | null
    fallbackChain: string[]
    providers: ProviderSnapshot[]
    connections: ConnectionSnapshot[]
    plugins: ExtensionSnapshot[]
    builtinTools: string[]
    memory: MemorySnapshot
    cost: CostSnapshot
    safety: SafetySnapshot
    build: BuildInfo
    generatedAt: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return `${h}h ${m}m`
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return String(n)
}

// ── Subcomponents ─────────────────────────────────────────────────────────────

function ProviderStatus({ status }: { status: ProviderSnapshot['status'] }) {
    if (status === 'primary') return <CheckCircle2 className="h-3.5 w-3.5 text-azure" />
    if (status === 'fallback') return <CheckCircle2 className="h-3.5 w-3.5 text-sky-400" />
    if (status === 'configured') return <CheckCircle2 className="h-3.5 w-3.5 text-text-muted" />
    return <Circle className="h-3.5 w-3.5 text-zinc-700" />
}

function ConnectionStatus({ status }: { status: ConnectionSnapshot['status'] }) {
    if (status === 'active') return <span className="text-[10px] font-medium text-azure bg-azure/10 border border-azure/20 px-1.5 py-0.5 rounded-full">active</span>
    if (status === 'error') return <span className="text-[10px] font-medium text-red bg-red/10 border border-red-400/20 px-1.5 py-0.5 rounded-full">error</span>
    if (status === 'expired') return <span className="text-[10px] font-medium text-amber bg-amber/10 border border-amber-400/20 px-1.5 py-0.5 rounded-full">expired</span>
    return <span className="text-[10px] font-medium text-text-muted bg-zinc-500/10 border border-zinc-500/20 px-1.5 py-0.5 rounded-full">pending</span>
}

function Chip({ label }: { label: string }) {
    return (
        <span className="text-[9px] font-medium text-azure bg-azure/10 border border-azure/20 px-1.5 py-0.5 rounded-full">
            {label}
        </span>
    )
}

function Section({
    title,
    icon: Icon,
    count,
    children,
    defaultOpen = true,
}: {
    title: string
    icon: React.ElementType
    count?: number
    children: React.ReactNode
    defaultOpen?: boolean
}) {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div className="rounded-xl border border-border/60 bg-surface-1/50 overflow-hidden">
            <button
                onClick={() => setOpen((o) => !o)}
                className="flex w-full items-center gap-2.5 px-4 py-3 hover:bg-surface-2/40 transition-colors min-h-[44px]"
            >
                <Icon className="h-4 w-4 text-azure shrink-0" />
                <span className="flex-1 text-left text-sm font-semibold text-text-primary">{title}</span>
                {count !== undefined && (
                    <span className="text-[10px] font-medium text-text-muted bg-surface-2 rounded-full px-2 py-0.5">
                        {count}
                    </span>
                )}
                {open
                    ? <ChevronDown className="h-3.5 w-3.5 text-text-muted shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-text-muted shrink-0" />
                }
            </button>
            {open && <div className="border-t border-border/60 px-4 py-3">{children}</div>}
        </div>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IntelligencePage() {
    const { workspaceId } = useWorkspace()
    const [snapshot, setSnapshot] = useState<IntrospectionSnapshot | null>(null)
    const [loading, setLoading] = useState(true)
    const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null)
    const [refreshing, setRefreshing] = useState(false)

    const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const fetch_ = useCallback(async (showSpinner = false) => {
        if (!WS_ID) {
            setLoading(false)
            return
        }
        if (showSpinner) setRefreshing(true)
        try {
            const url = `${API_BASE}/api/v1/workspaces/${WS_ID}/introspect${showSpinner ? '?bust=1' : ''}`
            const res = await fetch(url)
            if (res.ok) {
                const data = await res.json() as IntrospectionSnapshot
                setSnapshot(data)
                setLastRefreshed(new Date())
            }
        } catch { /* non-fatal */ } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }, [WS_ID, API_BASE])

    // Initial load
    useEffect(() => { void fetch_(false) }, [fetch_])

    // Poll every 30s
    useEffect(() => {
        const iv = setInterval(() => void fetch_(false), 30_000)
        return () => clearInterval(iv)
    }, [fetch_])

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="text-sm text-text-muted animate-pulse">Loading agent intelligence…</div>
            </div>
        )
    }

    if (!snapshot) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="text-sm text-text-muted">Could not load introspection data. Is the API running?</div>
            </div>
        )
    }

    const activeProviderInfo = snapshot.providers.find((p) => p.key === snapshot.activeProvider)
    const costPct = Math.min(100, snapshot.cost.percentUsed)

    return (
        <div className="space-y-6 max-w-6xl">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div>
                    <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
                        <BrainCircuit className="h-5 w-5 text-azure shrink-0" />
                        Agent Intelligence
                    </h1>
                    <p className="text-sm text-text-muted mt-0.5">
                        Live self-awareness snapshot for <span className="text-text-secondary font-medium">{snapshot.agentName}</span>
                    </p>
                </div>
                <button
                    onClick={() => void fetch_(true)}
                    disabled={refreshing}
                    className="flex items-center justify-center sm:justify-start gap-1.5 rounded-lg border border-border/60 bg-surface-2/60 px-3 py-1.5 text-sm sm:text-xs text-text-secondary hover:bg-zinc-700 hover:text-text-primary transition-colors disabled:opacity-50 min-h-[44px] w-full sm:w-auto"
                >
                    <RefreshCw className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {/* Identity card */}
            <div className="rounded-xl border border-azure/20  from-azure/5 to-zinc-900/60 p-4 sm:p-5">
                <div className="flex sm:items-center gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl   text-xl font-bold text-text-primary shadow-lg shadow-azure/20">
                        {snapshot.agentName.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
                            <h2 className="text-base font-bold text-text-primary truncate">{snapshot.agentName}</h2>
                            {snapshot.activeProvider && (
                                <span className="text-[10px] font-semibold bg-azure-dim text-azure border border-azure/30 rounded-full px-2 py-0.5 truncate max-w-full">
                                    {snapshot.activeProvider}{snapshot.activeModel ? ` / ${snapshot.activeModel}` : ''}
                                </span>
                            )}
                        </div>
                        {snapshot.agentTagline && (
                            <p className="text-sm text-text-secondary mt-0.5 truncate">{snapshot.agentTagline}</p>
                        )}
                        {snapshot.agentPersona && (
                            <p className="text-xs text-text-muted mt-1 line-clamp-2">{snapshot.agentPersona}</p>
                        )}
                    </div>
                    <div className="hidden xl:flex flex-col items-end gap-1 text-right shrink-0">
                        <span className="text-[10px] text-text-muted">v{snapshot.build.version}</span>
                        <span className="text-[10px] text-text-muted">uptime {formatUptime(snapshot.build.uptimeSeconds)}</span>
                        <span className="text-[10px] text-text-muted">{snapshot.build.memoryMb} MB RSS</span>
                        <span className="text-[10px] text-text-muted">Node {snapshot.build.nodeVersion}</span>
                    </div>
                </div>
            </div>

            {/* Two-column layout */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Left column */}
                <div className="space-y-4">
                    {/* Providers */}
                    <Section title="AI Providers" icon={Cpu} count={snapshot.providers.filter(p => p.status !== 'unconfigured').length}>
                        <div className="space-y-2">
                            {snapshot.providers.filter(p => p.status !== 'unconfigured').length === 0 && (
                                <p className="text-xs text-text-muted italic">No providers configured.</p>
                            )}
                            {snapshot.providers
                                .filter(p => p.status !== 'unconfigured')
                                .sort((a, b) => {
                                    const order = { primary: 0, fallback: 1, configured: 2, unconfigured: 3 }
                                    return order[a.status] - order[b.status]
                                })
                                .map((p) => (
                                    <div
                                        key={p.key}
                                        id={`provider-stat-${p.key}`}
                                        className={`rounded-lg border px-3 py-2 ${p.key === snapshot.activeProvider ? 'border-azure/30 bg-azure/20' : 'border-border/60 bg-surface-1/30'}`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <ProviderStatus status={p.status} />
                                            <span className="flex-1 text-sm font-medium text-text-primary">{p.name}</span>
                                            {p.key === snapshot.activeProvider && (
                                                <span className="text-[9px] font-bold text-azure bg-azure/10 border border-azure/20 px-1.5 py-0.5 rounded-full uppercase tracking-wide">Active</span>
                                            )}
                                            {p.status === 'fallback' && p.key !== snapshot.activeProvider && (
                                                <span className="text-[9px] font-medium text-sky-300 bg-sky-400/10 border border-sky-400/20 px-1.5 py-0.5 rounded-full">Fallback</span>
                                            )}
                                            {!p.enabled && (
                                                <span className="text-[9px] font-medium text-text-muted bg-surface-2 px-1.5 py-0.5 rounded-full">Disabled</span>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-text-muted mt-0.5 ml-5">{p.model}</p>
                                        {p.modalities.length > 0 && (
                                            <div className="flex flex-wrap gap-1 mt-1.5 ml-5">
                                                {p.modalities.map((m) => <Chip key={m} label={m} />)}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            <div className="pt-1">
                                <Link href="/settings/ai-providers" className="flex items-center min-h-[44px] px-2 -mx-2 text-sm sm:text-[11px] text-azure hover:text-azure transition-colors w-fit">
                                    Manage providers →
                                </Link>
                            </div>
                        </div>
                    </Section>

                    {/* Built-in tools */}
                    <Section title="Built-in Tools" icon={Wrench} count={snapshot.builtinTools.length}>
                        <div className="flex flex-wrap gap-1.5">
                            {snapshot.builtinTools.map((t) => (
                                <span key={t} className="text-[11px] font-mono text-text-secondary bg-surface-2 border border-border/50 rounded px-2 py-0.5">
                                    {t}
                                </span>
                            ))}
                        </div>
                    </Section>

                    {/* Safety */}
                    <Section title="Safety Limits" icon={ShieldAlert}>
                        <div className="space-y-2">
                            {[
                                { label: 'Max consecutive tool calls', value: String(snapshot.safety.maxConsecutiveToolCalls) },
                                { label: 'Wall clock limit', value: snapshot.safety.maxWallClockHuman },
                                { label: 'Max retries', value: String(snapshot.safety.maxRetries) },
                                { label: 'No force push', value: snapshot.safety.noForcePush ? 'Yes' : 'No' },
                                { label: 'No deletion without confirmation', value: snapshot.safety.noDeletionWithoutConfirmation ? 'Yes' : 'No' },
                                { label: 'No credentials in logs', value: snapshot.safety.noCredentialsInLogs ? 'Yes' : 'No' },
                            ].map(({ label, value }) => (
                                <div key={label} className="flex items-center justify-between text-xs">
                                    <span className="text-text-muted">{label}</span>
                                    <span className="font-mono text-text-secondary">{value}</span>
                                </div>
                            ))}
                            <p className="text-[10px] text-text-muted italic pt-1">Safety limits are constants — not configurable at runtime.</p>
                        </div>
                    </Section>
                </div>

                {/* Right column */}
                <div className="space-y-4">
                    {/* Cost */}
                    <Section title="Weekly Budget" icon={DollarSign}>
                        <div className="space-y-3">
                            <div className="flex items-end justify-between">
                                <span className="text-2xl font-bold text-text-primary">
                                    ${snapshot.cost.weeklyUsedUsd.toFixed(4)}
                                </span>
                                <span className="text-sm text-text-muted">
                                    of ${snapshot.cost.weeklyCeilingUsd.toFixed(2)} ceiling
                                </span>
                            </div>
                            {/* Progress bar */}
                            <div className="h-2 w-full rounded-full bg-surface-2 overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${costPct >= 80 ? 'bg-red' : costPct >= 60 ? 'bg-amber' : 'bg-azure'}`}
                                    style={{ width: `${costPct}%` }}
                                />
                            </div>
                            <div className="grid grid-cols-3 gap-2 pt-1">
                                {[
                                    { label: 'Tasks (7d)', value: String(snapshot.cost.taskCount7d) },
                                    { label: 'Avg quality', value: snapshot.cost.avgQuality7d != null ? `${(snapshot.cost.avgQuality7d * 100).toFixed(0)}%` : '—' },
                                    { label: 'Tokens (7d)', value: formatTokens(snapshot.cost.totalTokens7d) },
                                ].map(({ label, value }) => (
                                    <div key={label} className="rounded-lg bg-surface-2/60 border border-border/40 p-2 text-center">
                                        <div className="text-sm font-semibold text-text-primary">{value}</div>
                                        <div className="text-[10px] text-text-muted mt-0.5">{label}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </Section>

                    {/* Memory */}
                    <Section title="Memory" icon={MemoryStick}>
                        <div className="space-y-3">
                            <div className="flex items-end justify-between">
                                <span className="text-2xl font-bold text-text-primary">
                                    {snapshot.memory.totalEntries.toLocaleString()}
                                </span>
                                <span className="text-sm text-text-muted">total entries</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {Object.entries(snapshot.memory.byType).map(([type, count]) => (
                                    <div key={type} className="flex items-center justify-between rounded-lg bg-surface-2/60 border border-border/40 px-3 py-1.5">
                                        <span className="text-xs text-text-muted capitalize">{type}</span>
                                        <span className="text-xs font-semibold text-text-secondary">{count}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex items-center justify-between text-xs pt-1">
                                <span className="text-text-muted">Embedding coverage</span>
                                <div className="flex items-center gap-2">
                                    <div className="h-1.5 w-24 rounded-full bg-surface-2 overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-violet-500"
                                            style={{ width: `${snapshot.memory.embeddingCoveragePercent}%` }}
                                        />
                                    </div>
                                    <span className="font-mono text-text-secondary">{snapshot.memory.embeddingCoveragePercent}%</span>
                                </div>
                            </div>
                            {snapshot.memory.pendingImprovements > 0 && (
                                <div className="flex items-center gap-2 rounded-lg bg-amber/5 border border-amber-500/20 px-3 py-2">
                                    <TrendingUp className="h-3.5 w-3.5 text-amber shrink-0" />
                                    <span className="text-xs text-amber">
                                        {snapshot.memory.pendingImprovements} improvement proposal{snapshot.memory.pendingImprovements !== 1 ? 's' : ''} pending review
                                    </span>
                                </div>
                            )}
                            {snapshot.memory.recentPatterns.length > 0 && (
                                <div className="space-y-1 pt-1">
                                    <p className="text-[10px] font-semibold text-text-muted uppercase tracking-wider">Recent patterns</p>
                                    {snapshot.memory.recentPatterns.map((p, i) => (
                                        <p key={i} className="text-[11px] text-text-muted pl-2 border-l border-border">{p}</p>
                                    ))}
                                </div>
                            )}
                            <Link href="/insights" className="flex items-center text-sm sm:text-[11px] text-azure hover:text-azure transition-colors min-h-[44px] px-2 -mx-2 w-fit pt-1">
                                View memory →
                            </Link>
                        </div>
                    </Section>

                    {/* Build info */}
                    <Section title="Runtime" icon={Server} defaultOpen={false}>
                        <div className="space-y-1.5">
                            {[
                                { label: 'Version', value: `v${snapshot.build.version}` },
                                { label: 'Node.js', value: snapshot.build.nodeVersion },
                                { label: 'Uptime', value: formatUptime(snapshot.build.uptimeSeconds) },
                                { label: 'Memory (RSS)', value: `${snapshot.build.memoryMb} MB` },
                                { label: 'PID', value: String(snapshot.build.pid) },
                                { label: 'Build time', value: snapshot.build.buildTime ?? 'dev' },
                                { label: 'Snapshot age', value: lastRefreshed ? `${Math.round((Date.now() - lastRefreshed.getTime()) / 1000)}s ago` : '—' },
                            ].map(({ label, value }) => (
                                <div key={label} className="flex items-center justify-between text-xs">
                                    <span className="text-text-muted">{label}</span>
                                    <span className="font-mono text-text-secondary">{value}</span>
                                </div>
                            ))}
                        </div>
                    </Section>
                </div>
            </div>

            {/* Bottom — Connections & Extensions */}
            <Section
                title="Installed Connections"
                icon={Plug}
                count={snapshot.connections.length}
            >
                {snapshot.connections.length === 0 ? (
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 text-sm text-text-muted italic">
                        <div className="flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 text-zinc-700 shrink-0" />
                            <span>No connections installed.</span>
                        </div>
                        <Link href="/settings/connections" className="flex items-center min-h-[44px] px-4 -mx-4 sm:px-0 sm:mx-0 text-azure hover:text-azure not-italic sm:ml-auto w-fit">
                            Browse connections →
                        </Link>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {snapshot.connections.map((c) => (
                            <div
                                key={c.registryId}
                                className="rounded-lg border border-border/60 bg-surface-1/30 p-3 space-y-2"
                            >
                                <div className="flex items-center gap-2">
                                    <div className="h-6 w-6 rounded-md bg-surface-2 flex items-center justify-center text-[10px] font-bold text-text-secondary">
                                        {c.name.slice(0, 1).toUpperCase()}
                                    </div>
                                    <span className="flex-1 text-sm font-medium text-text-primary">{c.name}</span>
                                    <ConnectionStatus status={c.status} />
                                </div>
                                {c.tools.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                        {c.tools.slice(0, 6).map((t) => (
                                            <span key={t} className="text-[9px] font-mono text-text-muted bg-surface-2/60 border border-border/30 rounded px-1.5 py-0.5">
                                                {t.split('__').pop()}
                                            </span>
                                        ))}
                                        {c.tools.length > 6 && (
                                            <span className="text-[9px] text-text-muted">+{c.tools.length - 6} more</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            {snapshot.plugins.length > 0 && (
                <Section title="Extensions" icon={Zap} count={snapshot.plugins.filter(p => p.enabled).length}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {snapshot.plugins.map((p) => (
                            <div key={p.name} className={`rounded-lg border px-3 py-2 ${p.enabled ? 'border-border/60 bg-surface-1/30' : 'border-border/30 bg-surface-1/10 opacity-50'}`}>
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-sm font-medium text-text-primary">{p.name}</span>
                                    <span className="text-[9px] text-text-muted">v{p.version}</span>
                                    {!p.enabled && <span className="text-[9px] text-text-muted bg-surface-2 rounded px-1">disabled</span>}
                                </div>
                                {p.tools.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                        {p.tools.map((t) => <Chip key={t} label={t} />)}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </Section>
            )}

            {/* Last refreshed footer */}
            {lastRefreshed && (
                <p className="text-[10px] text-zinc-700 text-right">
                    Last refreshed {lastRefreshed.toLocaleTimeString()}. Auto-refreshes every 30s.
                </p>
            )}
        </div>
    )
}
