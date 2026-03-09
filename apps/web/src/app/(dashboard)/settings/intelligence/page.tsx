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

interface PluginSnapshot {
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
    activeProvider: string
    activeModel: string
    primaryProvider: string
    fallbackChain: string[]
    providers: ProviderSnapshot[]
    connections: ConnectionSnapshot[]
    plugins: PluginSnapshot[]
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
    if (status === 'primary') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    if (status === 'fallback') return <CheckCircle2 className="h-3.5 w-3.5 text-sky-400" />
    if (status === 'configured') return <CheckCircle2 className="h-3.5 w-3.5 text-zinc-500" />
    return <Circle className="h-3.5 w-3.5 text-zinc-700" />
}

function ConnectionStatus({ status }: { status: ConnectionSnapshot['status'] }) {
    if (status === 'active') return <span className="text-[10px] font-medium text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-1.5 py-0.5 rounded-full">active</span>
    if (status === 'error') return <span className="text-[10px] font-medium text-red-400 bg-red-400/10 border border-red-400/20 px-1.5 py-0.5 rounded-full">error</span>
    if (status === 'expired') return <span className="text-[10px] font-medium text-amber-400 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded-full">expired</span>
    return <span className="text-[10px] font-medium text-zinc-500 bg-zinc-500/10 border border-zinc-500/20 px-1.5 py-0.5 rounded-full">pending</span>
}

function Chip({ label }: { label: string }) {
    return (
        <span className="text-[9px] font-medium text-indigo-400 bg-indigo-400/10 border border-indigo-400/20 px-1.5 py-0.5 rounded-full">
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
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/50 overflow-hidden">
            <button
                onClick={() => setOpen((o) => !o)}
                className="flex w-full items-center gap-2.5 px-4 py-3 hover:bg-zinc-800/40 transition-colors min-h-[44px]"
            >
                <Icon className="h-4 w-4 text-indigo-400 shrink-0" />
                <span className="flex-1 text-left text-sm font-semibold text-zinc-200">{title}</span>
                {count !== undefined && (
                    <span className="text-[10px] font-medium text-zinc-500 bg-zinc-800 rounded-full px-2 py-0.5">
                        {count}
                    </span>
                )}
                {open
                    ? <ChevronDown className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                }
            </button>
            {open && <div className="border-t border-zinc-800/60 px-4 py-3">{children}</div>}
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
        if (!WS_ID) return
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
                <div className="text-sm text-zinc-500 animate-pulse">Loading agent intelligence…</div>
            </div>
        )
    }

    if (!snapshot) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="text-sm text-zinc-500">Could not load introspection data. Is the API running?</div>
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
                    <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
                        <BrainCircuit className="h-5 w-5 text-indigo-400 shrink-0" />
                        Agent Intelligence
                    </h1>
                    <p className="text-sm text-zinc-500 mt-0.5">
                        Live self-awareness snapshot for <span className="text-zinc-300 font-medium">{snapshot.agentName}</span>
                    </p>
                </div>
                <button
                    onClick={() => void fetch_(true)}
                    disabled={refreshing}
                    className="flex items-center justify-center sm:justify-start gap-1.5 rounded-lg border border-zinc-700/60 bg-zinc-800/60 px-3 py-1.5 text-sm sm:text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 transition-colors disabled:opacity-50 min-h-[44px] w-full sm:w-auto"
                >
                    <RefreshCw className={`h-4 w-4 sm:h-3.5 sm:w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {/* Identity card */}
            <div className="rounded-xl border border-indigo-500/20 bg-gradient-to-br from-indigo-950/40 to-zinc-900/60 p-4 sm:p-5">
                <div className="flex sm:items-center gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-xl font-bold text-white shadow-lg shadow-indigo-500/20">
                        {snapshot.agentName.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2 sm:gap-2.5">
                            <h2 className="text-base font-bold text-zinc-100 truncate">{snapshot.agentName}</h2>
                            <span className="text-[10px] font-semibold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-full px-2 py-0.5 truncate max-w-full">
                                {snapshot.activeProvider} / {snapshot.activeModel}
                            </span>
                        </div>
                        {snapshot.agentTagline && (
                            <p className="text-sm text-zinc-400 mt-0.5 truncate">{snapshot.agentTagline}</p>
                        )}
                        {snapshot.agentPersona && (
                            <p className="text-xs text-zinc-600 mt-1 line-clamp-2">{snapshot.agentPersona}</p>
                        )}
                    </div>
                    <div className="hidden xl:flex flex-col items-end gap-1 text-right shrink-0">
                        <span className="text-[10px] text-zinc-600">v{snapshot.build.version}</span>
                        <span className="text-[10px] text-zinc-600">uptime {formatUptime(snapshot.build.uptimeSeconds)}</span>
                        <span className="text-[10px] text-zinc-600">{snapshot.build.memoryMb} MB RSS</span>
                        <span className="text-[10px] text-zinc-600">Node {snapshot.build.nodeVersion}</span>
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
                                <p className="text-xs text-zinc-600 italic">No providers configured.</p>
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
                                        className={`rounded-lg border px-3 py-2 ${p.key === snapshot.activeProvider ? 'border-indigo-500/30 bg-indigo-950/20' : 'border-zinc-800/60 bg-zinc-900/30'}`}
                                    >
                                        <div className="flex items-center gap-2">
                                            <ProviderStatus status={p.status} />
                                            <span className="flex-1 text-sm font-medium text-zinc-200">{p.name}</span>
                                            {p.key === snapshot.activeProvider && (
                                                <span className="text-[9px] font-bold text-indigo-300 bg-indigo-400/10 border border-indigo-400/20 px-1.5 py-0.5 rounded-full uppercase tracking-wide">Active</span>
                                            )}
                                            {p.status === 'fallback' && p.key !== snapshot.activeProvider && (
                                                <span className="text-[9px] font-medium text-sky-300 bg-sky-400/10 border border-sky-400/20 px-1.5 py-0.5 rounded-full">Fallback</span>
                                            )}
                                            {!p.enabled && (
                                                <span className="text-[9px] font-medium text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded-full">Disabled</span>
                                            )}
                                        </div>
                                        <p className="text-[11px] text-zinc-500 mt-0.5 ml-5">{p.model}</p>
                                        {p.modalities.length > 0 && (
                                            <div className="flex flex-wrap gap-1 mt-1.5 ml-5">
                                                {p.modalities.map((m) => <Chip key={m} label={m} />)}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            <div className="pt-1">
                                <Link href="/settings/ai-providers" className="flex items-center min-h-[44px] px-2 -mx-2 text-sm sm:text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors w-fit">
                                    Manage providers →
                                </Link>
                            </div>
                        </div>
                    </Section>

                    {/* Built-in tools */}
                    <Section title="Built-in Tools" icon={Wrench} count={snapshot.builtinTools.length}>
                        <div className="flex flex-wrap gap-1.5">
                            {snapshot.builtinTools.map((t) => (
                                <span key={t} className="text-[11px] font-mono text-zinc-400 bg-zinc-800 border border-zinc-700/50 rounded px-2 py-0.5">
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
                                    <span className="text-zinc-500">{label}</span>
                                    <span className="font-mono text-zinc-300">{value}</span>
                                </div>
                            ))}
                            <p className="text-[10px] text-zinc-600 italic pt-1">Safety limits are constants — not configurable at runtime.</p>
                        </div>
                    </Section>
                </div>

                {/* Right column */}
                <div className="space-y-4">
                    {/* Cost */}
                    <Section title="Weekly Budget" icon={DollarSign}>
                        <div className="space-y-3">
                            <div className="flex items-end justify-between">
                                <span className="text-2xl font-bold text-zinc-100">
                                    ${snapshot.cost.weeklyUsedUsd.toFixed(4)}
                                </span>
                                <span className="text-sm text-zinc-500">
                                    of ${snapshot.cost.weeklyCeilingUsd.toFixed(2)} ceiling
                                </span>
                            </div>
                            {/* Progress bar */}
                            <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all ${costPct >= 80 ? 'bg-red-500' : costPct >= 60 ? 'bg-amber-400' : 'bg-emerald-500'}`}
                                    style={{ width: `${costPct}%` }}
                                />
                            </div>
                            <div className="grid grid-cols-3 gap-2 pt-1">
                                {[
                                    { label: 'Tasks (7d)', value: String(snapshot.cost.taskCount7d) },
                                    { label: 'Avg quality', value: snapshot.cost.avgQuality7d != null ? `${(snapshot.cost.avgQuality7d * 100).toFixed(0)}%` : '—' },
                                    { label: 'Tokens (7d)', value: formatTokens(snapshot.cost.totalTokens7d) },
                                ].map(({ label, value }) => (
                                    <div key={label} className="rounded-lg bg-zinc-800/60 border border-zinc-700/40 p-2 text-center">
                                        <div className="text-sm font-semibold text-zinc-200">{value}</div>
                                        <div className="text-[10px] text-zinc-600 mt-0.5">{label}</div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </Section>

                    {/* Memory */}
                    <Section title="Memory" icon={MemoryStick}>
                        <div className="space-y-3">
                            <div className="flex items-end justify-between">
                                <span className="text-2xl font-bold text-zinc-100">
                                    {snapshot.memory.totalEntries.toLocaleString()}
                                </span>
                                <span className="text-sm text-zinc-500">total entries</span>
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                {Object.entries(snapshot.memory.byType).map(([type, count]) => (
                                    <div key={type} className="flex items-center justify-between rounded-lg bg-zinc-800/60 border border-zinc-700/40 px-3 py-1.5">
                                        <span className="text-xs text-zinc-500 capitalize">{type}</span>
                                        <span className="text-xs font-semibold text-zinc-300">{count}</span>
                                    </div>
                                ))}
                            </div>
                            <div className="flex items-center justify-between text-xs pt-1">
                                <span className="text-zinc-500">Embedding coverage</span>
                                <div className="flex items-center gap-2">
                                    <div className="h-1.5 w-24 rounded-full bg-zinc-800 overflow-hidden">
                                        <div
                                            className="h-full rounded-full bg-violet-500"
                                            style={{ width: `${snapshot.memory.embeddingCoveragePercent}%` }}
                                        />
                                    </div>
                                    <span className="font-mono text-zinc-300">{snapshot.memory.embeddingCoveragePercent}%</span>
                                </div>
                            </div>
                            {snapshot.memory.pendingImprovements > 0 && (
                                <div className="flex items-center gap-2 rounded-lg bg-amber-500/5 border border-amber-500/20 px-3 py-2">
                                    <TrendingUp className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                                    <span className="text-xs text-amber-400">
                                        {snapshot.memory.pendingImprovements} improvement proposal{snapshot.memory.pendingImprovements !== 1 ? 's' : ''} pending review
                                    </span>
                                </div>
                            )}
                            {snapshot.memory.recentPatterns.length > 0 && (
                                <div className="space-y-1 pt-1">
                                    <p className="text-[10px] font-semibold text-zinc-600 uppercase tracking-wider">Recent patterns</p>
                                    {snapshot.memory.recentPatterns.map((p, i) => (
                                        <p key={i} className="text-[11px] text-zinc-500 pl-2 border-l border-zinc-800">{p}</p>
                                    ))}
                                </div>
                            )}
                            <Link href="/insights" className="flex items-center text-sm sm:text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors min-h-[44px] px-2 -mx-2 w-fit pt-1">
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
                                    <span className="text-zinc-500">{label}</span>
                                    <span className="font-mono text-zinc-300">{value}</span>
                                </div>
                            ))}
                        </div>
                    </Section>
                </div>
            </div>

            {/* Bottom — Connections & Plugins */}
            <Section
                title="Installed Connections"
                icon={Plug}
                count={snapshot.connections.length}
            >
                {snapshot.connections.length === 0 ? (
                    <div className="flex flex-col sm:flex-row sm:items-center gap-3 text-sm text-zinc-600 italic">
                        <div className="flex items-center gap-2">
                            <AlertCircle className="h-4 w-4 text-zinc-700 shrink-0" />
                            <span>No connections installed.</span>
                        </div>
                        <Link href="/settings/connections" className="flex items-center min-h-[44px] px-4 -mx-4 sm:px-0 sm:mx-0 text-indigo-400 hover:text-indigo-300 not-italic sm:ml-auto w-fit">
                            Browse integrations →
                        </Link>
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                        {snapshot.connections.map((c) => (
                            <div
                                key={c.registryId}
                                className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-3 space-y-2"
                            >
                                <div className="flex items-center gap-2">
                                    <div className="h-6 w-6 rounded-md bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-400">
                                        {c.name.slice(0, 1).toUpperCase()}
                                    </div>
                                    <span className="flex-1 text-sm font-medium text-zinc-200">{c.name}</span>
                                    <ConnectionStatus status={c.status} />
                                </div>
                                {c.tools.length > 0 && (
                                    <div className="flex flex-wrap gap-1">
                                        {c.tools.slice(0, 6).map((t) => (
                                            <span key={t} className="text-[9px] font-mono text-zinc-600 bg-zinc-800/60 border border-zinc-700/30 rounded px-1.5 py-0.5">
                                                {t.split('__').pop()}
                                            </span>
                                        ))}
                                        {c.tools.length > 6 && (
                                            <span className="text-[9px] text-zinc-600">+{c.tools.length - 6} more</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Section>

            {snapshot.plugins.length > 0 && (
                <Section title="Plugins" icon={Zap} count={snapshot.plugins.filter(p => p.enabled).length}>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {snapshot.plugins.map((p) => (
                            <div key={p.name} className={`rounded-lg border px-3 py-2 ${p.enabled ? 'border-zinc-800/60 bg-zinc-900/30' : 'border-zinc-800/30 bg-zinc-900/10 opacity-50'}`}>
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-sm font-medium text-zinc-200">{p.name}</span>
                                    <span className="text-[9px] text-zinc-600">v{p.version}</span>
                                    {!p.enabled && <span className="text-[9px] text-zinc-600 bg-zinc-800 rounded px-1">disabled</span>}
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
