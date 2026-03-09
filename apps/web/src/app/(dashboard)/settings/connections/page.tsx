// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import {
    Link2,
    Link2Off,
    ExternalLink,
    Key,
    Webhook,
    Globe2,
    CheckCircle2,
    Circle,
    AlertCircle,
    RefreshCw,
    Trash2,
    ToggleLeft,
    ToggleRight,
    Settings,
    Wrench,
    LayoutDashboard,
    Copy,
    Check,
    Code2,
    Link,
    MessageSquare,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

const FILTER_KEYS = ['category', 'status'] as const

interface ChannelSummary {
    id: string
    type: string
    name: string
    enabled: boolean
}

// ── Types ────────────────────────────────────────────────────────────────────

type AuthType = 'oauth2' | 'api_key' | 'webhook' | 'none'
type ConnectionStatus = 'active' | 'disconnected' | 'error'
type DetailTab = 'overview' | 'tools' | 'config'

interface SetupField {
    key: string
    label: string
    type: 'text' | 'password' | 'url'
    required?: boolean
    placeholder?: string
    /** If set, shown as a "Create token →" deep link in the connect UI */
    tokenUrl?: string
}

interface RegistryItem {
    id: string
    name: string
    description: string
    category: string
    logoUrl: string | null
    authType: AuthType
    oauthScopes: string[]
    setupFields: SetupField[]
    toolsProvided: string[]
    cardsProvided: string[]
    isCore: boolean
    docUrl: string | null
    /** npm package for the MCP server, e.g. '@modelcontextprotocol/server-github' */
    mcpPackage?: string | null
}

interface InstalledConnection {
    id: string
    registryId: string
    name: string
    status: ConnectionStatus
    enabledTools: string[] | null  // null = all enabled
    scopesGranted: string[]
    lastVerifiedAt: string | null
    createdAt: string
}

interface ConnectedItem extends RegistryItem {
    installed: InstalledConnection
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

/** Channel type → integration registry ID mapping */
const CHANNEL_TO_REGISTRY: Record<string, string> = {
    telegram: 'telegram',
    slack: 'slack',
    discord: 'discord',
    github: 'github',
    linear: 'linear',
    jira: 'jira',
    notion: 'notion',
}

function categoryColor(cat: string): string {
    const map: Record<string, string> = {
        code: 'bg-violet-500/15 text-violet-400 border border-violet-500/30',
        developer: 'bg-violet-500/15 text-violet-400 border border-violet-500/30',
        communication: 'bg-blue-500/15 text-blue-400 border border-blue-500/30',
        productivity: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
        finance: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
        analytics: 'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30',
        storage: 'bg-orange-500/15 text-orange-400 border border-orange-500/30',
    }
    return map[cat.toLowerCase()] ?? 'bg-zinc-700/40 text-zinc-400 border border-zinc-700'
}

function AuthIcon({ type }: { type: AuthType }) {
    if (type === 'oauth2') return <Globe2 className="h-3.5 w-3.5 text-blue-400" />
    if (type === 'api_key') return <Key className="h-3.5 w-3.5 text-amber-400" />
    if (type === 'webhook') return <Webhook className="h-3.5 w-3.5 text-violet-400" />
    return null
}

function AuthBadge({ type }: { type: AuthType }) {
    const map: Record<AuthType, { label: string; cls: string }> = {
        oauth2: { label: 'OAuth2', cls: 'bg-blue-500/10 text-blue-400 border-blue-500/20' },
        api_key: { label: 'API Key / PAT', cls: 'bg-amber-500/10 text-amber-400 border-amber-500/20' },
        webhook: { label: 'Webhook', cls: 'bg-violet-500/10 text-violet-400 border-violet-500/20' },
        none: { label: 'No Auth', cls: 'bg-zinc-700/30 text-zinc-500 border-zinc-700/30' },
    }
    const { label, cls } = map[type]
    return (
        <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
            <AuthIcon type={type} />
            {label}
        </span>
    )
}

function CopySnippet({ code }: { code: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <div className="relative group">
            <pre className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-[11px] font-mono text-zinc-400 overflow-x-auto whitespace-pre leading-relaxed pr-9">{code}</pre>
            <button
                onClick={() => { void navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000) }}
                className="absolute right-2 top-2 p-1.5 rounded-md bg-zinc-800 text-zinc-500 opacity-0 group-hover:opacity-100 transition-opacity hover:text-zinc-200"
            >
                {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            </button>
        </div>
    )
}

function StatusDot({ status }: { status: ConnectionStatus }) {
    if (status === 'active') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    if (status === 'error') return <AlertCircle className="h-3.5 w-3.5 text-red-400" />
    return <Circle className="h-3.5 w-3.5 text-zinc-600" />
}

const ALL_CATEGORIES = ['All', 'Code', 'Communication', 'Productivity', 'Finance', 'Analytics', 'Storage']

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IntegrationsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [registry, setRegistry] = useState<RegistryItem[]>([])
    const [installed, setInstalled] = useState<InstalledConnection[]>([])
    const [selected, setSelected] = useState<RegistryItem | null>(null)
    const [loading, setLoading] = useState(true)
    const [channels, setChannels] = useState<ChannelSummary[]>([])

    const lf = useListFilter(FILTER_KEYS, 'default')
    const { search, filterValues, clearAll } = lf
    const [installing, setInstalling] = useState(false)
    const [disconnecting, setDisconnecting] = useState(false)
    const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
    const [activeTab, setActiveTab] = useState<DetailTab>('overview')
    const [savingTools, setSavingTools] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const fetchData = useCallback(async () => {
        setLoading(true)
        try {
            const [regRes, instRes, chanRes] = await Promise.all([
                fetch(`${API_BASE}/api/v1/connections/registry`),
                WS_ID ? fetch(`${API_BASE}/api/v1/connections/installed?workspaceId=${WS_ID}`) : Promise.resolve(null),
                WS_ID ? fetch(`${API_BASE}/api/v1/channels?workspaceId=${WS_ID}`) : Promise.resolve(null),
            ])
            if (regRes.ok) {
                const d = await regRes.json() as { items: RegistryItem[] }
                setRegistry(d.items)
                if (!selected && d.items.length > 0) setSelected(d.items[0])
            }
            if (instRes?.ok) {
                const d = await instRes.json() as { items: InstalledConnection[] }
                setInstalled(d.items)
            }
            if (chanRes?.ok) {
                const d = await chanRes.json() as { items: ChannelSummary[] }
                setChannels(d.items ?? [])
            }
        } catch {
            setError('Failed to load connections')
        } finally {
            setLoading(false)
        }
    }, [selected])

    useEffect(() => { void fetchData() }, [])  // eslint-disable-line react-hooks/exhaustive-deps

    const connectedItem = selected
        ? installed.find((i) => i.registryId === selected.id) ?? null
        : null

    const isConnected = connectedItem !== null

    /** Channels that correspond to the currently selected integration */
    const linkedChannels = selected
        ? channels.filter((ch) => CHANNEL_TO_REGISTRY[ch.type] === selected.id)
        : []

    // Tools that are enabled for this connection (null = all)
    const enabledTools: string[] | null = connectedItem?.enabledTools ?? null
    const allTools = selected?.toolsProvided ?? []

    function isToolEnabled(tool: string): boolean {
        if (enabledTools === null) return true
        return enabledTools.includes(tool)
    }

    async function toggleTool(tool: string) {
        if (!connectedItem) return
        setSavingTools(true)
        const current: string[] = enabledTools ?? [...allTools]
        const next = current.includes(tool)
            ? current.filter((t) => t !== tool)
            : [...current, tool]
        // null means all enabled — normalise back if all are checked
        const payload: string[] | null = next.length === allTools.length ? null : next
        try {
            await fetch(`${API_BASE}/api/v1/connections/installed/${connectedItem.id}/tools`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, enabledTools: payload }),
            })
            setInstalled((prev) => prev.map((i) =>
                i.id === connectedItem.id ? { ...i, enabledTools: payload } : i
            ))
        } finally {
            setSavingTools(false)
        }
    }

    async function handleInstall() {
        if (!selected || !WS_ID) return

        // OAuth2 providers: open a popup to the provider OAuth start URL
        if (selected.authType === 'oauth2') {
            const oauthUrl = `${API_BASE}/api/v1/oauth/${selected.id}/start?workspaceId=${WS_ID}`
            const popup = window.open(oauthUrl, 'plexo_oauth', 'width=600,height=700,left=200,top=100')
            if (!popup) {
                setError('Popup blocked — please allow popups for this site.')
                return
            }
            setInstalling(true)
            const handleMessage = (ev: MessageEvent) => {
                if (ev.data?.type !== 'oauth_callback') return
                window.removeEventListener('message', handleMessage)
                setInstalling(false)
                if (ev.data.ok) {
                    void fetchData()
                    setActiveTab('tools')
                } else if (ev.data.error === 'setup_required') {
                    const envVar = String(ev.data.envVar ?? `${selected.id.toUpperCase()}_CLIENT_ID`)
                    const msg = String(ev.data.message ?? '')
                    setError(
                        `${selected.name} OAuth not configured: set ${envVar} in the API environment. ${msg}`
                    )
                } else {
                    setError(`OAuth failed: ${String(ev.data.error ?? 'unknown')}`)
                }
            }
            window.addEventListener('message', handleMessage)
            // Clean up if user closes popup without completing
            const pollClosed = setInterval(() => {
                if (popup.closed) {
                    clearInterval(pollClosed)
                    window.removeEventListener('message', handleMessage)
                    setInstalling(false)
                }
            }, 500)
            return
        }

        // API key / webhook: send credentials directly
        setInstalling(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/connections/install`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId: WS_ID,
                    registryId: selected.id,
                    credentials: fieldValues,
                }),
            })
            if (res.ok) {
                await fetchData()
                setFieldValues({})
                setActiveTab('tools')
            } else {
                const d = await res.json() as { error?: { message?: string } }
                setError(d.error?.message ?? 'Install failed')
            }
        } finally {
            setInstalling(false)
        }
    }

    async function handleDisconnect() {
        if (!connectedItem || !WS_ID) return
        setDisconnecting(true)
        try {
            await fetch(`${API_BASE}/api/v1/connections/installed/${connectedItem.id}?workspaceId=${WS_ID}`, {
                method: 'DELETE',
            })
            setInstalled((prev) => prev.filter((i) => i.id !== connectedItem.id))
            setActiveTab('overview')
        } finally {
            setDisconnecting(false)
        }
    }

    const filtered = registry.filter((r) => {
        const matchCat = !filterValues.category || filterValues.category === 'all' || r.category.toLowerCase() === filterValues.category.toLowerCase()
        const matchStatus = (() => {
            if (!filterValues.status) return true
            const isInstalled = installed.some((i) => i.registryId === r.id)
            if (filterValues.status === 'connected') return isInstalled
            if (filterValues.status === 'unconnected') return !isInstalled
            return true
        })()
        const matchSearch = !search ||
            r.name.toLowerCase().includes(search.toLowerCase()) ||
            r.description.toLowerCase().includes(search.toLowerCase()) ||
            r.category.toLowerCase().includes(search.toLowerCase())
        return matchCat && matchStatus && matchSearch
    })

    // Connected items first, then alphabetical
    const sorted = [...filtered].sort((a, b) => {
        if (lf.sort === 'name_asc') return a.name.localeCompare(b.name)
        if (lf.sort === 'name_desc') return b.name.localeCompare(a.name)

        const aConnected = installed.some((i) => i.registryId === a.id) ? 0 : 1
        const bConnected = installed.some((i) => i.registryId === b.id) ? 0 : 1
        return aConnected - bConnected || a.name.localeCompare(b.name)
    })

    const dimensions: FilterDimension[] = [
        {
            key: 'category',
            label: 'Category',
            options: ALL_CATEGORIES.slice(1).map((cat) => ({
                value: cat.toLowerCase(),
                label: cat,
                dimmed: !registry.some(r => r.category.toLowerCase() === cat.toLowerCase())
            }))
        },
        {
            key: 'status',
            label: 'Status',
            options: [
                { value: 'connected', label: 'Connected', dimmed: installed.length === 0 },
                { value: 'unconnected', label: 'Unconnected', dimmed: installed.length === registry.length },
            ]
        }
    ]

    return (
        <div className="flex flex-col gap-4 h-full">
            {/* Header */}
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Integrations</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Manage authenticated external services • {installed.length} active
                </p>
            </div>

            {error && (
                <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 text-xs text-red-400 flex items-center justify-between">
                    {error}
                    <button onClick={() => setError(null)} className="text-red-600 hover:text-red-400">✕</button>
                </div>
            )}

            <ListToolbar
                hook={lf}
                placeholder="Search connections…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Priority (Connected first)', value: 'default' },
                    { label: 'Name (A-Z)', value: 'name_asc' },
                    { label: 'Name (Z-A)', value: 'name_desc' },
                ]}
            />

            {/* Two-panel layout */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 pt-2 pb-4 md:pb-0">

                {/* Left panel — list */}
                <div className="w-full md:w-[280px] shrink-0 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-y-auto pb-2 md:pb-0 snap-x snap-mandatory [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    {/* List */}
                    <div className="flex-1 flex flex-row md:flex-col gap-2 md:gap-1">
                        {loading ? (
                            <div className="flex items-center justify-center py-8 min-w-[200px] shrink-0 snap-start">
                                <RefreshCw className="h-4 w-4 text-zinc-600 animate-spin" />
                            </div>
                        ) : sorted.length === 0 ? (
                            <p className="text-center text-xs text-zinc-600 py-6 min-w-[200px] shrink-0 snap-start">No results</p>
                        ) : (
                            sorted.map((r) => {
                                const inst = installed.find((i) => i.registryId === r.id)
                                const active = r.id === selected?.id
                                const linkedChs = channels.filter((ch) => CHANNEL_TO_REGISTRY[ch.type] === r.id)
                                const hasActiveChannel = linkedChs.some((ch) => ch.enabled)
                                return (
                                    <button
                                        key={r.id}
                                        onClick={() => { setSelected(r); setActiveTab('overview') }}
                                        className={`text-left rounded-xl border px-3 py-2.5 transition-all text-sm shrink-0 snap-start min-w-[250px] md:min-w-0 md:w-full min-h-[44px] ${active
                                            ? 'border-indigo-500/50 bg-zinc-900 shadow-sm shadow-indigo-500/10'
                                            : 'border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/60'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between gap-2 h-full">
                                            <div className="flex items-center gap-2.5">
                                                {r.logoUrl ? (
                                                    <span className="relative h-6 w-6 shrink-0">
                                                        <img
                                                            src={r.logoUrl}
                                                            alt={r.name}
                                                            className="h-6 w-6 rounded object-contain bg-white/5"
                                                            onError={(e) => {
                                                                e.currentTarget.style.display = 'none';
                                                                (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty('display', 'flex')
                                                            }}
                                                        />
                                                        <span className="h-6 w-6 rounded bg-zinc-800 items-center justify-center text-[10px] font-bold text-zinc-400 hidden" style={{ display: 'none' }}>
                                                            {r.name.slice(0, 2).toUpperCase()}
                                                        </span>
                                                    </span>
                                                ) : (
                                                    <div className="h-6 w-6 rounded bg-zinc-800 flex items-center justify-center text-[10px] font-bold text-zinc-400">
                                                        {r.name.slice(0, 2).toUpperCase()}
                                                    </div>
                                                )}
                                                <span className="text-sm font-medium text-zinc-200 truncate max-w-[120px]">{r.name}</span>
                                            </div>
                                            <div className="flex items-center gap-1.5 shrink-0">
                                                <AuthIcon type={r.authType} />
                                                {hasActiveChannel && (
                                                    <span title={`Channel: ${linkedChs.map(c => c.name).join(', ')}`}>
                                                        <MessageSquare className="h-3 w-3 text-teal-400" />
                                                    </span>
                                                )}
                                                {inst ? <StatusDot status={inst.status} /> : <Circle className="h-3 w-3 text-zinc-700" />}
                                            </div>
                                        </div>
                                    </button>
                                )
                            })
                        )}
                    </div>
                </div>

                {/* Right panel — detail */}
                {selected ? (
                    <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/40 flex flex-col overflow-hidden max-w-[100vw] sm:max-w-none">
                        {/* Detail header */}
                        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 border-b border-zinc-800">
                            <div className="flex items-start gap-3">
                                {selected.logoUrl ? (
                                    <img src={selected.logoUrl} alt={selected.name} className="h-10 w-10 mt-1 sm:mt-0 rounded-lg object-contain bg-white/5 shrink-0" />
                                ) : (
                                    <div className="h-10 w-10 mt-1 sm:mt-0 rounded-lg bg-zinc-800 flex items-center justify-center text-sm font-bold text-zinc-300 shrink-0">
                                        {selected.name.slice(0, 2).toUpperCase()}
                                    </div>
                                )}
                                <div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <h2 className="text-base font-semibold text-zinc-100">{selected.name}</h2>
                                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${categoryColor(selected.category)}`}>
                                            {selected.category}
                                        </span>
                                        <AuthBadge type={selected.authType} />
                                        {selected.mcpPackage && (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-medium text-rose-400">
                                                <Code2 className="h-2.5 w-2.5" />
                                                MCP
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        {isConnected && (
                                            <>
                                                <StatusDot status={connectedItem!.status} />
                                                <span className="text-xs text-emerald-400">Connected</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
                                {selected.docUrl && (
                                    <a
                                        href={selected.docUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center justify-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors min-h-[44px] sm:min-h-0 flex-1 sm:flex-initial"
                                    >
                                        <ExternalLink className="h-3 w-3" />
                                        Docs
                                    </a>
                                )}
                                {isConnected ? (
                                    <button
                                        onClick={() => void handleDisconnect()}
                                        disabled={disconnecting}
                                        className="flex items-center justify-center gap-1.5 rounded-lg border border-red-800/50 bg-red-950/30 px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-red-400 hover:border-red-700 hover:bg-red-950/50 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0 flex-1 sm:flex-initial whitespace-nowrap"
                                    >
                                        <Trash2 className="h-3 w-3" />
                                        {disconnecting ? 'Removing…' : 'Disconnect'}
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => void handleInstall()}
                                        disabled={installing || !WS_ID}
                                        className="flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 sm:px-3 sm:py-1.5 text-sm sm:text-xs font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0 flex-[2] sm:flex-initial"
                                    >
                                        <Link2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                                        {installing ? 'Connecting…' : 'Connect'}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Tabs (only shown when connected) */}
                        {isConnected && (
                            <div className="flex gap-0 border-b border-zinc-800">
                                {([
                                    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
                                    { id: 'tools', label: 'Tools', icon: Wrench },
                                    { id: 'config', label: 'Config', icon: Settings },
                                ] as const).map(({ id, label, icon: Icon }) => (
                                    <button
                                        key={id}
                                        onClick={() => setActiveTab(id)}
                                        className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${activeTab === id
                                            ? 'border-indigo-500 text-indigo-400'
                                            : 'border-transparent text-zinc-500 hover:text-zinc-300'
                                            }`}
                                    >
                                        <Icon className="h-3.5 w-3.5" />
                                        {label}
                                    </button>
                                ))}
                            </div>
                        )}

                        {/* Tab content */}
                        <div className="flex-1 overflow-y-auto p-5">

                            {/* Overview tab / not connected state */}
                            {(!isConnected || activeTab === 'overview') && (
                                <div className="flex flex-col gap-5">
                                    <p className="text-sm text-zinc-400">{selected.description}</p>

                                    {/* Connection metadata if connected */}
                                    {isConnected && connectedItem && (
                                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-col gap-2">
                                            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Connection details</p>
                                            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 sm:gap-y-1.5 text-sm">
                                                <div>
                                                    <dt className="text-zinc-600 text-[11px] sm:text-xs">Status</dt>
                                                    <dd className="flex items-center gap-1.5">
                                                        <StatusDot status={connectedItem.status} />
                                                        <span className="text-zinc-300 capitalize">{connectedItem.status}</span>
                                                    </dd>
                                                </div>
                                                <div>
                                                    <dt className="text-zinc-600 text-[11px] sm:text-xs">Connected</dt>
                                                    <dd className="text-zinc-300">{new Date(connectedItem.createdAt).toLocaleDateString()}</dd>
                                                </div>
                                                {connectedItem.lastVerifiedAt && (
                                                    <div>
                                                        <dt className="text-zinc-600 text-[11px] sm:text-xs">Last verified</dt>
                                                        <dd className="text-zinc-300">{new Date(connectedItem.lastVerifiedAt).toLocaleDateString()}</dd>
                                                    </div>
                                                )}
                                                {connectedItem.scopesGranted.length > 0 && (
                                                    <div className="sm:col-span-2">
                                                        <dt className="text-zinc-600 text-[11px] sm:text-xs">Scopes</dt>
                                                        <dd className="text-zinc-300">{connectedItem.scopesGranted.join(', ')}</dd>
                                                    </div>
                                                )}
                                            </dl>
                                        </div>
                                    )}

                                    {/* Setup fields for not-yet-connected */}
                                    {!isConnected && (selected.setupFields ?? []).length > 0 && (
                                        <div className="flex flex-col gap-3">
                                            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Configuration</h3>
                                            {selected.setupFields.map((field) => (
                                                <div key={field.key} className="flex flex-col gap-1">
                                                    <div className="flex items-center justify-between">
                                                        <label className="text-sm font-medium text-zinc-300">
                                                            {field.label} {field.required && <span className="text-red-500">*</span>}
                                                        </label>
                                                        {field.tokenUrl && (
                                                            <a
                                                                href={field.tokenUrl}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
                                                            >
                                                                <ExternalLink className="h-3 w-3" />
                                                                Create token
                                                            </a>
                                                        )}
                                                    </div>
                                                    <input
                                                        type={field.type === 'password' ? 'password' : 'text'}
                                                        value={fieldValues[field.key] ?? ''}
                                                        onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                                        placeholder={field.placeholder ?? ''}
                                                        className="min-h-[44px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[16px] sm:text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* OAuth2 notice */}
                                    {!isConnected && selected.authType === 'oauth2' && (
                                        <div className="rounded-lg border border-blue-800/40 bg-blue-950/20 px-3 py-3 text-xs text-blue-400">
                                            <p className="font-semibold mb-1">OAuth2 — secure redirect flow</p>
                                            <p className="text-blue-400">Clicking Connect will open a popup to authenticate with {selected.name}. Requires <code className="text-blue-300">{selected.id.toUpperCase().replace('-', '_')}_CLIENT_ID</code> set in the API environment.</p>
                                        </div>
                                    )}

                                    {/* Channel cross-reference */}
                                    {linkedChannels.length > 0 && (
                                        <div className="rounded-lg border border-teal-800/30 bg-teal-950/20 px-3 py-3 flex flex-col gap-1.5">
                                            <p className="text-xs font-semibold text-teal-400 flex items-center gap-1.5">
                                                <MessageSquare className="h-3.5 w-3.5" />
                                                {linkedChannels.length === 1 ? 'Channel adapter active' : `${linkedChannels.length} channel adapters active`}
                                            </p>
                                            <div className="flex flex-col gap-1">
                                                {linkedChannels.map((ch) => (
                                                    <div key={ch.id} className="flex items-center justify-between">
                                                        <span className="text-[11px] text-teal-400/70">{ch.name}</span>
                                                        <span className={`text-[10px] font-medium ${ch.enabled ? 'text-emerald-400' : 'text-zinc-500'}`}>
                                                            {ch.enabled ? 'enabled' : 'disabled'}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                            <a
                                                href="/settings/channels"
                                                className="flex items-center gap-1 text-[11px] text-teal-400 hover:text-teal-300 transition-colors mt-0.5"
                                            >
                                                <Link className="h-3 w-3" />
                                                Manage in Channels →
                                            </a>
                                        </div>
                                    )}

                                    {/* API key note: Plexo manages the MCP config */}
                                    {!isConnected && selected.authType === 'api_key' && selected.mcpPackage && (
                                        <div className="rounded-lg border border-rose-800/30 bg-rose-950/20 px-3 py-3 flex flex-col gap-1.5">
                                            <p className="text-xs font-semibold text-rose-400 flex items-center gap-1.5"><Code2 className="h-3.5 w-3.5" /> Plexo manages the MCP connection</p>
                                            <p className="text-[11px] text-rose-400/70 leading-relaxed">
                                                After you save your token, Plexo automatically adds <code className="text-rose-300">{selected.mcpPackage}</code> to the agent&apos;s MCP runtime. No manual config editing required.
                                            </p>
                                        </div>
                                    )}

                                    {/* Provided tools + cards */}
                                    {allTools.length > 0 && (
                                        <div>
                                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Tools provided</h3>
                                            <div className="flex flex-wrap gap-1.5">
                                                {allTools.map((t) => (
                                                    <span key={t} className="rounded border border-zinc-800 bg-zinc-800/60 px-2 py-0.5 text-xs text-zinc-400 font-mono">{t}</span>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {selected.oauthScopes.length > 0 && (
                                        <div>
                                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">OAuth scopes requested</h3>
                                            <div className="flex flex-wrap gap-1.5">
                                                {selected.oauthScopes.map((s) => (
                                                    <span key={s} className="rounded border border-zinc-800 bg-zinc-800/60 px-2 py-0.5 text-xs text-zinc-400 font-mono">{s}</span>
                                                ))}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Tools tab */}
                            {isConnected && activeTab === 'tools' && (
                                <div className="flex flex-col gap-3">
                                    <div className="flex items-center justify-between">
                                        <p className="text-xs text-zinc-500">
                                            Enable or disable individual tools from this connection.
                                            Disabled tools are hidden from the agent runtime.
                                        </p>
                                        {savingTools && <RefreshCw className="h-3.5 w-3.5 text-zinc-600 animate-spin" />}
                                    </div>
                                    {allTools.length === 0 ? (
                                        <p className="text-sm text-zinc-600">This connection provides no agent tools.</p>
                                    ) : (
                                        <div className="flex flex-col gap-1">
                                            {allTools.map((tool) => {
                                                const enabled = isToolEnabled(tool)
                                                return (
                                                    <button
                                                        key={tool}
                                                        onClick={() => void toggleTool(tool)}
                                                        disabled={savingTools}
                                                        className={`flex items-center justify-between min-h-[44px] rounded-lg border px-3 py-2.5 text-left transition-all disabled:opacity-60 ${enabled
                                                            ? 'border-zinc-700/60 bg-zinc-900/60 hover:border-zinc-600'
                                                            : 'border-zinc-800/40 bg-zinc-900/20 opacity-60 hover:opacity-80'
                                                            }`}
                                                    >
                                                        <div className="flex items-center gap-2.5 truncate mr-3">
                                                            <Wrench className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                                                            <span className="text-sm font-mono text-zinc-300 truncate">{tool}</span>
                                                        </div>
                                                        {enabled
                                                            ? <ToggleRight className="h-6 w-6 sm:h-5 sm:w-5 text-indigo-400 shrink-0" />
                                                            : <ToggleLeft className="h-6 w-6 sm:h-5 sm:w-5 text-zinc-700 shrink-0" />
                                                        }
                                                    </button>
                                                )
                                            })}
                                        </div>
                                    )}
                                    <p className="text-xs text-zinc-700 mt-1">
                                        {enabledTools === null
                                            ? `All ${allTools.length} tools enabled`
                                            : `${enabledTools.length} / ${allTools.length} tools enabled`
                                        }
                                    </p>

                                    {/* MCP config preview */}
                                    {selected.mcpPackage && (
                                        <div className="mt-3 flex flex-col gap-2">
                                            <div className="flex items-center gap-1.5">
                                                <Code2 className="h-3.5 w-3.5 text-rose-400" />
                                                <p className="text-xs font-semibold text-zinc-400">Managed MCP config</p>
                                                <span className="text-[10px] text-zinc-600">— Plexo writes this for you</span>
                                            </div>
                                            <CopySnippet code={JSON.stringify({
                                                [selected.id]: {
                                                    command: 'npx',
                                                    args: ['-y', selected.mcpPackage, 'stdio'],
                                                    env: {
                                                        [`${selected.id.toUpperCase().replace(/-/g, '_')}_PERSONAL_ACCESS_TOKEN`]: '*** stored securely ***',
                                                    }
                                                }
                                            }, null, 2)} />
                                            <p className="text-[10px] text-zinc-700">The actual token is stored encrypted in the database and injected at agent runtime. It is never written to disk.</p>
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Config tab */}
                            {isConnected && activeTab === 'config' && (
                                <div className="flex flex-col gap-4">
                                    {(selected.setupFields ?? []).length > 0 ? (
                                        <>
                                            <p className="text-xs text-zinc-500">Update credentials for this connection.</p>
                                            {selected.setupFields.map((field) => (
                                                <div key={field.key} className="flex flex-col gap-1">
                                                    <label className="text-sm font-medium text-zinc-300">
                                                        {field.label}
                                                    </label>
                                                    <input
                                                        type={field.type === 'password' ? 'password' : 'text'}
                                                        value={fieldValues[field.key] ?? ''}
                                                        onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                                        placeholder="Leave blank to keep current value"
                                                        className="min-h-[44px] rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-[16px] sm:text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                                                    />
                                                </div>
                                            ))}
                                        </>
                                    ) : selected.authType === 'oauth2' ? (
                                        <div className="flex flex-col gap-2">
                                            <p className="text-sm text-zinc-400">OAuth2 connection — no manual credentials required.</p>
                                            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 flex items-center gap-2">
                                                <Globe2 className="h-4 w-4 text-blue-400" />
                                                <span className="text-xs text-zinc-500">Scopes: {connectedItem?.scopesGranted.join(', ') || 'none recorded'}</span>
                                            </div>
                                        </div>
                                    ) : (
                                        <p className="text-sm text-zinc-600">No configuration fields for this connection.</p>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/40 flex items-center justify-center">
                        <div className="text-center">
                            <Link2Off className="mx-auto h-8 w-8 text-zinc-700 mb-2" />
                            <p className="text-sm text-zinc-600">Select a service</p>
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            {!WS_ID && (
                <p className="text-xs text-red-500">NEXT_PUBLIC_DEFAULT_WORKSPACE not set — connections will not persist.</p>
            )}
        </div>
    )
}
