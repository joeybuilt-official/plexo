// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import {
    Activity,
    Database,
    Server,
    Wifi,
    WifiOff,
    RefreshCw,
    Terminal,
    CheckCircle2,
    XCircle,
    Clock,
    ChevronDown,
    ChevronRight,
    Copy,
    Check,
    Cpu,
    Play,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ────────────────────────────────────────────────────────────────────

interface ServiceHealth {
    ok: boolean
    latencyMs?: number
    error?: string
}

interface HealthPayload {
    status: 'ok' | 'degraded' | 'down'
    services: Record<string, ServiceHealth>
    version?: string
    uptime?: number
}

interface RouteCheck {
    route: string
    label: string
    params?: Record<string, string>
    requiresWorkspace?: boolean
}

const ROUTE_CHECKS: RouteCheck[] = [
    { route: '/health', label: 'Health endpoint' },
    { route: '/api/v1/workspaces', label: 'Workspaces list' },
    { route: '/api/v1/connections/registry', label: 'Connections registry' },
    { route: '/api/v1/dashboard/summary', label: 'Dashboard summary', requiresWorkspace: true },
    { route: '/api/v1/memory/preferences', label: 'Memory preferences', requiresWorkspace: true },
    { route: '/api/v1/tasks', label: 'Tasks list', requiresWorkspace: true },
    { route: '/api/v1/agent/status', label: 'Agent status' },
]

// ── Components ────────────────────────────────────────────────────────────────

function ServiceBadge({ name, health }: { name: string; health: ServiceHealth }) {
    return (
        <div className={`flex items-center justify-between rounded-lg border px-3 py-2.5 ${health.ok
            ? 'border-emerald-800/40 bg-emerald-950/20'
            : 'border-red-800/40 bg-red-950/20'
            }`}>
            <div className="flex items-center gap-2">
                {health.ok
                    ? <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                    : <XCircle className="h-4 w-4 text-red-400" />
                }
                <span className="text-sm font-medium capitalize text-zinc-200">{name}</span>
            </div>
            <div className="flex items-center gap-3">
                {health.error && (
                    <span className="text-xs text-red-400 truncate max-w-[200px]">{health.error}</span>
                )}
                {health.latencyMs !== undefined && (
                    <span className="text-xs text-zinc-500">{health.latencyMs}ms</span>
                )}
            </div>
        </div>
    )
}

function RouteRow({ check, result, wsId }: { check: RouteCheck; result: { ok: boolean; status: number; latencyMs: number } | null; wsId: string }) {
    const url = check.requiresWorkspace && wsId
        ? `${API_BASE}${check.route}?workspaceId=${wsId}`
        : `${API_BASE}${check.route}`

    return (
        <tr className="border-b border-zinc-800/50">
            <td className="py-2 pr-4 text-sm text-zinc-300">{check.label}</td>
            <td className="py-2 pr-4 font-mono text-xs text-zinc-500">{check.route}</td>
            <td className="py-2 pr-4">
                {!result ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin text-zinc-600" />
                ) : (
                    <span className={`inline-flex items-center gap-1 text-xs font-medium ${result.ok ? 'text-emerald-400' : 'text-red-400'
                        }`}>
                        {result.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                        {result.status}
                    </span>
                )}
            </td>
            <td className="py-2 text-xs text-zinc-600">
                {result ? `${result.latencyMs}ms` : '—'}
            </td>
        </tr>
    )
}

function CopyButton({ value }: { value: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <button
            onClick={() => {
                void navigator.clipboard.writeText(value)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
            }}
            className="rounded p-1 text-zinc-600 hover:text-zinc-300 transition-colors"
        >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function DebugPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [health, setHealth] = useState<HealthPayload | null>(null)
    const [healthLoading, setHealthLoading] = useState(true)
    const [routeResults, setRouteResults] = useState<Record<string, { ok: boolean; status: number; latencyMs: number }>>({})
    const [routeLoading, setRouteLoading] = useState(false)
    const [sseStatus, setSseStatus] = useState<'connecting' | 'open' | 'closed' | 'error'>('connecting')
    const [sseEvents, setSseEvents] = useState<string[]>([])
    const [envOpen, setEnvOpen] = useState(false)
    // Snapshot
    const [snapshot, setSnapshot] = useState<Record<string, unknown> | null>(null)
    const [snapshotLoading, setSnapshotLoading] = useState(false)
    // RPC
    const [rpcMethod, setRpcMethod] = useState('ping')
    const [rpcParams, setRpcParams] = useState('')
    const [rpcResult, setRpcResult] = useState<string | null>(null)
    const [rpcLoading, setRpcLoading] = useState(false)

    const fetchHealth = useCallback(async () => {
        setHealthLoading(true)
        try {
            const res = await fetch(`${API_BASE}/health`)
            if (res.ok) setHealth(await res.json() as HealthPayload)
        } finally {
            setHealthLoading(false)
        }
    }, [])

    const runRouteChecks = useCallback(async () => {
        setRouteLoading(true)
        setRouteResults({})
        await Promise.all(
            ROUTE_CHECKS.map(async (check) => {
                const url = check.requiresWorkspace && WS_ID
                    ? `${API_BASE}${check.route}?workspaceId=${WS_ID}`
                    : `${API_BASE}${check.route}`
                const start = Date.now()
                try {
                    const r = await fetch(url)
                    setRouteResults((prev) => ({
                        ...prev,
                        [check.route]: { ok: r.status < 400, status: r.status, latencyMs: Date.now() - start },
                    }))
                } catch {
                    setRouteResults((prev) => ({
                        ...prev,
                        [check.route]: { ok: false, status: 0, latencyMs: Date.now() - start },
                    }))
                }
            })
        )
        setRouteLoading(false)
    }, [])

    const fetchSnapshot = useCallback(async () => {
        setSnapshotLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/debug/snapshot`)
            if (res.ok) setSnapshot(await res.json() as Record<string, unknown>)
        } finally {
            setSnapshotLoading(false)
        }
    }, [])

    async function runRpc() {
        setRpcLoading(true)
        setRpcResult(null)
        try {
            let params: Record<string, unknown> = {}
            if (rpcParams.trim()) {
                try { params = JSON.parse(rpcParams) as Record<string, unknown> } catch { /* ignore bad JSON */ }
            }
            const res = await fetch(`${API_BASE}/api/v1/debug/rpc`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ method: rpcMethod, params }),
            })
            const json = await res.json() as unknown
            setRpcResult(JSON.stringify(json, null, 2))
        } catch (e) {
            setRpcResult(`Error: ${(e as Error).message}`)
        } finally {
            setRpcLoading(false)
        }
    }

    // Health auto-fetch
    useEffect(() => { void fetchHealth() }, [fetchHealth])

    // SSE diagnostics
    useEffect(() => {
        if (!WS_ID) {
            setSseStatus('error')
            return
        }
        const es = new EventSource(`${API_BASE}/api/v1/sse?workspaceId=${WS_ID}`)
        setSseStatus('connecting')
        es.onopen = () => setSseStatus('open')
        es.onerror = () => setSseStatus('error')
        es.onmessage = (e) => {
            setSseEvents((prev) => [`[message] ${e.data}`, ...prev].slice(0, 20))
        }
        // Capture named events
        const evts = ['task:started', 'task:completed', 'task:failed', 'sprint:updated', 'ping']
        for (const name of evts) {
            es.addEventListener(name, (e) => {
                setSseEvents((prev) => [`[${name}] ${(e as MessageEvent).data ?? ''}`, ...prev].slice(0, 20))
            })
        }
        return () => es.close()
    }, [])

    const envVars: Array<[string, string]> = [
        ['NEXT_PUBLIC_API_URL', API_BASE],
        ['NEXT_PUBLIC_DEFAULT_WORKSPACE', WS_ID || '(not set)'],
    ]

    const uptimeHuman = health?.uptime !== undefined
        ? health.uptime < 60
            ? `${health.uptime}s`
            : health.uptime < 3600
                ? `${Math.floor(health.uptime / 60)}m ${health.uptime % 60}s`
                : `${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m`
        : '—'

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Debug</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">Service health, route diagnostics, and SSE stream monitor</p>
                </div>
                <button
                    onClick={() => { void fetchHealth(); void runRouteChecks() }}
                    disabled={healthLoading || routeLoading}
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${(healthLoading || routeLoading) ? 'animate-spin' : ''}`} />
                    Refresh all
                </button>
            </div>

            {/* Snapshot panel */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-zinc-500" />
                        <span className="text-sm font-semibold text-zinc-200">Runtime Snapshot</span>
                    </div>
                    <button
                        onClick={() => void fetchSnapshot()}
                        disabled={snapshotLoading}
                        className="flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${snapshotLoading ? 'animate-spin' : ''}`} />
                        Fetch
                    </button>
                </div>
                {!snapshot ? (
                    <p className="text-xs text-zinc-600">Click Fetch to load runtime state from /api/v1/debug/snapshot</p>
                ) : (
                    <pre className="rounded-lg bg-zinc-950 p-3 text-[11px] font-mono text-zinc-400 overflow-auto max-h-56 whitespace-pre-wrap">{JSON.stringify(snapshot, null, 2)}</pre>
                )}
            </div>

            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
                {/* Health status card */}
                <div className="col-span-2 xl:col-span-1 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <Activity className="h-4 w-4 text-zinc-500" />
                            <span className="text-sm font-semibold text-zinc-200">Service Health</span>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-zinc-600">
                            <Clock className="h-3.5 w-3.5" />
                            uptime: {uptimeHuman}
                        </div>
                    </div>
                    {healthLoading ? (
                        <div className="flex items-center gap-2 py-4 text-sm text-zinc-600">
                            <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
                        </div>
                    ) : health ? (
                        <div className="flex flex-col gap-2">
                            <div className={`mb-1 text-xs font-semibold uppercase tracking-wider ${health.status === 'ok' ? 'text-emerald-500' : 'text-red-500'
                                }`}>{health.status.toUpperCase()}</div>
                            {Object.entries(health.services).map(([name, svc]) => (
                                <ServiceBadge key={name} name={name} health={svc} />
                            ))}
                            <p className="mt-1 text-right text-[10px] text-zinc-700">v{health.version}</p>
                        </div>
                    ) : (
                        <p className="text-sm text-red-400">Health endpoint unreachable</p>
                    )}
                </div>

                {/* SSE monitor */}
                <div className="col-span-2 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                    <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2">
                            <Wifi className="h-4 w-4 text-zinc-500" />
                            <span className="text-sm font-semibold text-zinc-200">SSE Stream</span>
                        </div>
                        <div className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${sseStatus === 'open'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : sseStatus === 'connecting'
                                ? 'bg-amber-500/15 text-amber-400'
                                : 'bg-red-500/15 text-red-400'
                            }`}>
                            {sseStatus === 'open' ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                            {sseStatus}
                        </div>
                    </div>
                    <div className="h-36 overflow-y-auto rounded-lg bg-zinc-950 p-3 font-mono text-[11px] text-zinc-500">
                        {sseEvents.length === 0 ? (
                            <span className="text-zinc-700">Waiting for events…</span>
                        ) : (
                            sseEvents.map((ev, i) => (
                                <div key={i} className="text-zinc-400">{ev}</div>
                            ))
                        )}
                    </div>
                    {!WS_ID && (
                        <p className="mt-2 text-xs text-amber-400">
                            NEXT_PUBLIC_DEFAULT_WORKSPACE not set — SSE stream disabled
                        </p>
                    )}
                </div>
            </div>

            {/* Route diagnostics */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                        <Server className="h-4 w-4 text-zinc-500" />
                        <span className="text-sm font-semibold text-zinc-200">Route Diagnostics</span>
                    </div>
                    <button
                        onClick={() => void runRouteChecks()}
                        disabled={routeLoading}
                        className="flex items-center gap-1.5 rounded-lg border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                        <Terminal className={`h-3.5 w-3.5 ${routeLoading ? 'animate-pulse' : ''}`} />
                        Run checks
                    </button>
                </div>
                <table className="w-full">
                    <thead>
                        <tr className="border-b border-zinc-800 text-left">
                            <th className="pb-2 text-xs font-semibold text-zinc-600">Endpoint</th>
                            <th className="pb-2 text-xs font-semibold text-zinc-600">Route</th>
                            <th className="pb-2 text-xs font-semibold text-zinc-600">Status</th>
                            <th className="pb-2 text-xs font-semibold text-zinc-600">Latency</th>
                        </tr>
                    </thead>
                    <tbody>
                        {ROUTE_CHECKS.map((check) => (
                            <RouteRow
                                key={check.route}
                                check={check}
                                result={routeResults[check.route] ?? null}
                                wsId={WS_ID}
                            />
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Environment */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                <button
                    onClick={() => setEnvOpen((v) => !v)}
                    className="flex w-full items-center justify-between p-4 text-left text-sm font-semibold text-zinc-200 hover:bg-zinc-800/30 transition-colors"
                >
                    <div className="flex items-center gap-2">
                        <Database className="h-4 w-4 text-zinc-500" />
                        Client-side Environment
                    </div>
                    {envOpen ? <ChevronDown className="h-4 w-4 text-zinc-600" /> : <ChevronRight className="h-4 w-4 text-zinc-600" />}
                </button>
                {envOpen && (
                    <div className="border-t border-zinc-800 px-4 pb-4 pt-3 flex flex-col gap-2">
                        {envVars.map(([key, val]) => (
                            <div key={key} className="flex items-center justify-between rounded-lg bg-zinc-950 px-3 py-2">
                                <span className="font-mono text-xs text-zinc-500">{key}</span>
                                <div className="flex items-center gap-1.5">
                                    <span className="font-mono text-xs text-zinc-300">{val}</span>
                                    <CopyButton value={val} />
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* RPC console */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
                <div className="flex items-center gap-2 mb-3">
                    <Terminal className="h-4 w-4 text-zinc-500" />
                    <span className="text-sm font-semibold text-zinc-200">RPC Console</span>
                </div>
                <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                        <select
                            value={rpcMethod}
                            onChange={(e) => setRpcMethod(e.target.value)}
                            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
                        >
                            {['ping', 'queue.stats', 'memory.list', 'memory.run_improvement', 'agent.status'].map((m) => (
                                <option key={m} value={m}>{m}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => void runRpc()}
                            disabled={rpcLoading}
                            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
                        >
                            <Play className="h-3 w-3" />
                            {rpcLoading ? 'Running…' : 'Run'}
                        </button>
                    </div>
                    <textarea
                        value={rpcParams}
                        onChange={(e) => setRpcParams(e.target.value)}
                        placeholder='Optional JSON params e.g. {"workspaceId": "..."}'
                        rows={2}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs font-mono text-zinc-300 placeholder:text-zinc-700 focus:border-indigo-500 focus:outline-none resize-none"
                    />
                    {rpcResult && (
                        <pre className="rounded-lg bg-zinc-950 p-3 text-[11px] font-mono text-zinc-400 overflow-auto max-h-48 whitespace-pre-wrap">{rpcResult}</pre>
                    )}
                </div>
            </div>
        </div>
    )
}

