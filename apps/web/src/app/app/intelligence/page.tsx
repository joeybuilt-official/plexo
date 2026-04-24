// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Intelligence visibility dashboard — Phase 5.
 *
 * Top-level `/app/intelligence` page (NOT a settings sub-page). Three
 * tabs: Flow / Health / Logs. Cost summary card at the top. SSE stream
 * drops in a light refresh nudge every 3s so the dashboard can stay
 * open and show live activity.
 *
 * Single-file layout so the Phase 5 surface fits in one commit without
 * splitting into 5 files the way the spec suggests. Every sub-view is
 * a small component defined below.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { mutate as swrMutate } from 'swr'
import {
    Activity, BrainCircuit, Database, DollarSign, Loader2, Network,
    Heart, ListTree, Sparkles, ArrowRight, RefreshCw, CheckCircle2, XCircle, HelpCircle,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import {
    useFlow, useHealth, useLogs, useCostSummary,
    type LogEntry,
} from '@web/lib/intelligence-dashboard-client'

type TabKey = 'flow' | 'health' | 'logs'

export default function IntelligenceDashboardPage() {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null
    const [tab, setTab] = useState<TabKey>('flow')

    // SSE refresh nudge — when a tick arrives, revalidate cost + logs.
    useEffect(() => {
        if (!workspaceId) return
        let es: EventSource | null = null
        try {
            es = new EventSource(`/api/v1/intel-dashboard/${workspaceId}/stream`, { withCredentials: true })
            es.addEventListener('tick', () => {
                void swrMutate(`/api/v1/intel-dashboard/${workspaceId}/cost-summary`)
                void swrMutate((key) => typeof key === 'string' && key.startsWith(`/api/v1/intel-dashboard/${workspaceId}/logs`))
            })
            es.onerror = () => { /* EventSource will auto-reconnect */ }
        } catch { /* ignore */ }
        return () => { es?.close() }
    }, [workspaceId])

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-border p-4">
                <div className="flex items-center gap-2">
                    <BrainCircuit className="h-5 w-5 text-azure" />
                    <div>
                        <h1 className="text-base font-semibold text-text-primary">Intelligence</h1>
                        <p className="text-xs text-text-muted">
                            Where your data goes — embeddings, memory, SCL, router, logs, cost.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Link
                        href="/app/settings/intelligence"
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-text-muted hover:text-text-primary"
                    >
                        Settings <ArrowRight className="h-3 w-3" />
                    </Link>
                </div>
            </div>

            {!workspaceId ? (
                <div className="p-4">
                    <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar.
                    </div>
                </div>
            ) : (
                <>
                    <div className="border-b border-border p-4">
                        <CostCard workspaceId={workspaceId} />
                    </div>

                    <div className="flex items-center gap-2 border-b border-border p-3">
                        <TabButton active={tab === 'flow'} onClick={() => setTab('flow')} icon={Network} label="Flow" />
                        <TabButton active={tab === 'health'} onClick={() => setTab('health')} icon={Heart} label="Health" />
                        <TabButton active={tab === 'logs'} onClick={() => setTab('logs')} icon={ListTree} label="Logs" />
                    </div>

                    <div className="flex-1 overflow-y-auto p-4">
                        {tab === 'flow' && <FlowView workspaceId={workspaceId} />}
                        {tab === 'health' && <HealthView workspaceId={workspaceId} />}
                        {tab === 'logs' && <LogsView workspaceId={workspaceId} />}
                    </div>
                </>
            )}
        </div>
    )
}

function TabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof Network; label: string }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs transition-colors ${
                active
                    ? 'border-azure bg-surface-1 text-azure ring-1 ring-azure/40'
                    : 'border-border bg-surface-1 text-text-muted hover:text-text-primary'
            }`}
        >
            <Icon className="h-3 w-3" />
            {label}
        </button>
    )
}

// ── Cost card ───────────────────────────────────────────────────────────

function CostCard({ workspaceId }: { workspaceId: string }) {
    const { data, isLoading } = useCostSummary(workspaceId)
    if (isLoading || !data) {
        return (
            <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                <Loader2 className="mr-2 inline h-3 w-3 animate-spin" /> Loading cost summary…
            </div>
        )
    }
    const month = new Date(data.spend.monthStart).toLocaleString('en-US', { month: 'long' })
    return (
        <div className="rounded-xl border border-border bg-surface-1 p-4">
            <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-azure" />
                <h3 className="text-sm font-medium text-text-primary">{month} spend</h3>
            </div>
            <div className="mt-2 grid gap-4 sm:grid-cols-4">
                <Metric
                    label="Priced"
                    value={`$${data.spend.pricedUsd.toFixed(4)}`}
                    sub={`${data.spend.requests} request${data.spend.requests === 1 ? '' : 's'}`}
                />
                <Metric
                    label="Tokens in / out"
                    value={`${fmt(data.spend.inputTokens)} / ${fmt(data.spend.outputTokens)}`}
                    sub={data.spend.unpricedInputTokens + data.spend.unpricedOutputTokens > 0
                        ? `${fmt(data.spend.unpricedInputTokens + data.spend.unpricedOutputTokens)} unpriced`
                        : 'all priced'}
                />
                <Metric
                    label="Top model"
                    value={data.topModel?.model ?? '—'}
                    sub={data.topModel ? `$${data.topModel.costUsd.toFixed(4)} · ${data.topModel.requests} req` : 'no priced activity'}
                />
                <Metric
                    label="Top task"
                    value={data.topTaskType?.taskType ?? '—'}
                    sub={data.topTaskType ? `$${data.topTaskType.costUsd.toFixed(4)} · ${data.topTaskType.requests} req` : 'no priced activity'}
                />
            </div>
        </div>
    )
}

function Metric({ label, value, sub }: { label: string; value: string; sub: string }) {
    return (
        <div>
            <div className="text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
            <div className="mt-0.5 text-sm font-medium text-text-primary truncate">{value}</div>
            <div className="text-[11px] text-text-muted">{sub}</div>
        </div>
    )
}

function fmt(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
}

// ── Flow view ───────────────────────────────────────────────────────────

function FlowView({ workspaceId }: { workspaceId: string }) {
    const { data, isLoading } = useFlow(workspaceId)
    if (isLoading || !data) {
        return (
            <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                <Loader2 className="mr-2 inline h-3 w-3 animate-spin" /> Loading flow…
            </div>
        )
    }
    const enabledProviders = data.providers.filter(p => p.enabled)
    return (
        <div className="space-y-4">
            <div className="rounded-xl border border-border bg-surface-1 p-4">
                <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-azure" />
                    <h3 className="text-sm font-medium text-text-primary">Providers ({enabledProviders.length} enabled)</h3>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                    {enabledProviders.length === 0 ? (
                        <span className="text-xs text-text-muted">No enabled providers. Configure in Settings → AI Providers.</span>
                    ) : (
                        enabledProviders.map(p => (
                            <div key={p.id} className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs">
                                <span className="text-text-primary">{p.providerType}</span>
                                {p.selectedModel && <span className="ml-1 text-text-muted">· {p.selectedModel}</span>}
                                {p.embeddingModel && <span className="ml-1 text-azure text-[10px]">emb</span>}
                                {p.managed && <span className="ml-1 text-amber-300 text-[10px]">managed</span>}
                            </div>
                        ))
                    )}
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <FlowStep
                    icon={Database}
                    title="Embeddings"
                    primary={`${data.embeddings.configured} / ${data.embeddings.totalEnabled} providers`}
                    secondary="Memory recall + SCL expansion"
                    href="/app/settings/intelligence"
                />
                <FlowStep
                    icon={BrainCircuit}
                    title="SCL"
                    primary="Enabled"
                    secondary={`Drift threshold ${data.scl.driftThreshold.toFixed(2)}`}
                    href="/app/settings/intelligence/scl"
                />
                <FlowStep
                    icon={Network}
                    title="Router"
                    primary={`${data.chains.length} / 7 chains configured`}
                    secondary={`Mode: ${data.inferenceMode}`}
                    href="/app/settings/intelligence"
                />
            </div>

            <div className="rounded-xl border border-border bg-surface-1 p-4">
                <div className="flex items-center gap-2">
                    <ListTree className="h-4 w-4 text-azure" />
                    <h3 className="text-sm font-medium text-text-primary">Routing chains by task type</h3>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {data.chains.length === 0 ? (
                        <span className="text-xs text-text-muted">No chains configured yet — startup seed may still be pending.</span>
                    ) : (
                        data.chains.map(c => (
                            <div key={c.taskType} className="rounded-md border border-border bg-surface-1 px-2 py-1 text-xs">
                                <span className="text-text-primary">{c.taskType}</span>
                                <span className="ml-1 text-text-muted">{c.length} model{c.length === 1 ? '' : 's'}</span>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}

function FlowStep({ icon: Icon, title, primary, secondary, href }: {
    icon: typeof Network; title: string; primary: string; secondary: string; href: string
}) {
    return (
        <Link
            href={href}
            className="group rounded-xl border border-border bg-surface-1 p-4 transition-colors hover:border-azure"
        >
            <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-azure" />
                <h4 className="text-sm font-medium text-text-primary">{title}</h4>
            </div>
            <div className="mt-2 text-sm text-text-primary">{primary}</div>
            <div className="text-[11px] text-text-muted">{secondary}</div>
        </Link>
    )
}

// ── Health view ─────────────────────────────────────────────────────────

function HealthView({ workspaceId }: { workspaceId: string }) {
    const { data, isLoading, mutate } = useHealth(workspaceId)
    if (isLoading || !data) {
        return (
            <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                <Loader2 className="mr-2 inline h-3 w-3 animate-spin" /> Probing services…
            </div>
        )
    }
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div className="text-[11px] text-text-muted">
                    Checked {new Date(data.checkedAt).toLocaleTimeString()}
                </div>
                <button
                    type="button"
                    onClick={() => void mutate()}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
                >
                    <RefreshCw className="h-3 w-3" /> Re-probe
                </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
                {data.services.map(s => {
                    const Icon = s.status === 'up' ? CheckCircle2 : s.status === 'down' ? XCircle : HelpCircle
                    const tone = s.status === 'up' ? 'text-emerald-300 border-emerald-700/40'
                        : s.status === 'down' ? 'text-rose-300 border-rose-700/40'
                        : 'text-text-muted border-border'
                    return (
                        <div key={s.name} className={`rounded-xl border bg-surface-1 p-3 ${tone}`}>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Icon className="h-4 w-4" />
                                    <span className="text-sm font-medium text-text-primary">{s.name}</span>
                                </div>
                                {s.latencyMs != null && (
                                    <span className="text-[11px] tabular-nums text-text-muted">{s.latencyMs}ms</span>
                                )}
                            </div>
                            {s.detail && (
                                <p className="mt-1 text-[11px] text-text-muted">{s.detail}</p>
                            )}
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

// ── Logs view ───────────────────────────────────────────────────────────

function LogsView({ workspaceId }: { workspaceId: string }) {
    const [taskType, setTaskType] = useState('')
    const [model, setModel] = useState('')
    const { data, isLoading } = useLogs(workspaceId, {
        taskType: taskType || undefined,
        model: model || undefined,
        limit: 200,
    })

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                <input
                    type="text"
                    value={taskType}
                    onChange={e => setTaskType(e.target.value)}
                    placeholder="Task type filter…"
                    className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted"
                />
                <input
                    type="text"
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    placeholder="Model filter…"
                    className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-xs text-text-primary placeholder:text-text-muted"
                />
                {(taskType || model) && (
                    <button
                        type="button"
                        onClick={() => { setTaskType(''); setModel('') }}
                        className="text-[11px] text-text-muted hover:text-text-primary"
                    >
                        Clear
                    </button>
                )}
            </div>
            {isLoading ? (
                <div className="flex items-center justify-center py-8 text-xs text-text-muted">
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading logs…
                </div>
            ) : !data || data.logs.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                    No inference logs match.
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-border bg-surface-1">
                    <table className="w-full text-left text-[11px]">
                        <thead className="border-b border-border text-text-muted">
                            <tr>
                                <th className="px-3 py-2 font-normal">When</th>
                                <th className="px-3 py-2 font-normal">Task</th>
                                <th className="px-3 py-2 font-normal">Model</th>
                                <th className="px-3 py-2 font-normal text-right">In / Out</th>
                                <th className="px-3 py-2 font-normal text-right">Latency</th>
                                <th className="px-3 py-2 font-normal text-right">Cost</th>
                                <th className="px-3 py-2 font-normal text-right">OK</th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.logs.map((l: LogEntry) => (
                                <tr key={l.id} className="border-b border-border/40 last:border-0">
                                    <td className="px-3 py-1.5 text-text-muted">{new Date(l.createdAt).toLocaleTimeString()}</td>
                                    <td className="px-3 py-1.5 text-text-primary">{l.taskType}</td>
                                    <td className="px-3 py-1.5 text-text-primary">{l.model}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums text-text-muted">
                                        {fmt(l.inputTokens)} / {fmt(l.outputTokens)}
                                    </td>
                                    <td className="px-3 py-1.5 text-right tabular-nums text-text-muted">{l.latencyMs}ms</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums text-text-primary">
                                        {l.priced ? `$${l.costUsd.toFixed(4)}` : '—'}
                                    </td>
                                    <td className="px-3 py-1.5 text-right">
                                        {l.success
                                            ? <CheckCircle2 className="inline h-3 w-3 text-emerald-300" />
                                            : <XCircle className="inline h-3 w-3 text-rose-300" />}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="border-t border-border p-2 text-center text-[11px] text-text-muted">
                        Showing {data.logs.length} log{data.logs.length === 1 ? '' : 's'}
                    </div>
                </div>
            )}
            {/* Activity icon reference so the import is used */}
            <span className="sr-only"><Activity aria-hidden /></span>
        </div>
    )
}
