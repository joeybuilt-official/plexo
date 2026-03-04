'use client'

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
    ChevronRight,
    Search,
    ToggleLeft,
    ToggleRight,
    Settings,
    Wrench,
    LayoutDashboard,
} from 'lucide-react'

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

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
const WS_ID = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''

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

function StatusDot({ status }: { status: ConnectionStatus }) {
    if (status === 'active') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    if (status === 'error') return <AlertCircle className="h-3.5 w-3.5 text-red-400" />
    return <Circle className="h-3.5 w-3.5 text-zinc-600" />
}

const ALL_CATEGORIES = ['All', 'Code', 'Communication', 'Productivity', 'Finance', 'Analytics', 'Storage']

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ConnectionsPage() {
    const [registry, setRegistry] = useState<RegistryItem[]>([])
    const [installed, setInstalled] = useState<InstalledConnection[]>([])
    const [selected, setSelected] = useState<RegistryItem | null>(null)
    const [category, setCategory] = useState('All')
    const [search, setSearch] = useState('')
    const [loading, setLoading] = useState(true)
    const [installing, setInstalling] = useState(false)
    const [disconnecting, setDisconnecting] = useState(false)
    const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
    const [activeTab, setActiveTab] = useState<DetailTab>('overview')
    const [savingTools, setSavingTools] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const fetchData = useCallback(async () => {
        setLoading(true)
        try {
            const [regRes, instRes] = await Promise.all([
                fetch(`${API_BASE}/api/connections/registry`),
                WS_ID ? fetch(`${API_BASE}/api/connections/installed?workspaceId=${WS_ID}`) : Promise.resolve(null),
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
            await fetch(`${API_BASE}/api/connections/installed/${connectedItem.id}/tools`, {
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
            const oauthUrl = `${API_BASE}/api/oauth/${selected.id}/start?workspaceId=${WS_ID}`
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
            const res = await fetch(`${API_BASE}/api/connections/install`, {
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
            await fetch(`${API_BASE}/api/connections/installed/${connectedItem.id}?workspaceId=${WS_ID}`, {
                method: 'DELETE',
            })
            setInstalled((prev) => prev.filter((i) => i.id !== connectedItem.id))
            setActiveTab('overview')
        } finally {
            setDisconnecting(false)
        }
    }

    const filtered = registry.filter((r) => {
        const matchCat = category === 'All' || r.category.toLowerCase() === category.toLowerCase()
        const matchSearch = !search ||
            r.name.toLowerCase().includes(search.toLowerCase()) ||
            r.description.toLowerCase().includes(search.toLowerCase()) ||
            r.category.toLowerCase().includes(search.toLowerCase())
        return matchCat && matchSearch
    })

    // Connected items first, then alphabetical
    const sorted = [...filtered].sort((a, b) => {
        const aConnected = installed.some((i) => i.registryId === a.id) ? 0 : 1
        const bConnected = installed.some((i) => i.registryId === b.id) ? 0 : 1
        return aConnected - bConnected || a.name.localeCompare(b.name)
    })

    return (
        <div className="flex flex-col gap-4 h-full">
            {/* Header */}
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Connections</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Connect external services • {installed.length} active
                </p>
            </div>

            {error && (
                <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 text-xs text-red-400 flex items-center justify-between">
                    {error}
                    <button onClick={() => setError(null)} className="text-red-600 hover:text-red-400">✕</button>
                </div>
            )}

            {/* Category tabs */}
            <div className="flex gap-1 flex-wrap">
                {ALL_CATEGORIES.map((cat) => (
                    <button
                        key={cat}
                        onClick={() => setCategory(cat)}
                        className={`rounded-lg px-3 py-1 text-xs font-medium transition-colors ${category === cat
                            ? 'bg-indigo-600 text-white'
                            : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                            }`}
                    >
                        {cat}
                    </button>
                ))}
            </div>

            {/* Two-panel layout */}
            <div className="flex gap-4 flex-1 min-h-0">

                {/* Left panel — list */}
                <div className="w-[260px] shrink-0 flex flex-col gap-2">
                    {/* Search */}
                    <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-600" />
                        <input
                            type="text"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search…"
                            className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 pl-8 pr-3 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-700 focus:border-indigo-500 focus:outline-none"
                        />
                    </div>

                    {/* List */}
                    <div className="flex-1 overflow-y-auto flex flex-col gap-1">
                        {loading ? (
                            <div className="flex items-center justify-center py-8">
                                <RefreshCw className="h-4 w-4 text-zinc-600 animate-spin" />
                            </div>
                        ) : sorted.length === 0 ? (
                            <p className="text-center text-xs text-zinc-600 py-6">No results</p>
                        ) : (
                            sorted.map((r) => {
                                const inst = installed.find((i) => i.registryId === r.id)
                                const active = r.id === selected?.id
                                return (
                                    <button
                                        key={r.id}
                                        onClick={() => { setSelected(r); setActiveTab('overview') }}
                                        className={`text-left rounded-xl border px-3 py-2.5 transition-all ${active
                                            ? 'border-indigo-500/50 bg-zinc-900 shadow-sm shadow-indigo-500/10'
                                            : 'border-zinc-800/60 bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/60'
                                            }`}
                                    >
                                        <div className="flex items-center justify-between gap-2">
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
                    <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/40 flex flex-col overflow-hidden">
                        {/* Detail header */}
                        <div className="flex items-start justify-between gap-4 p-5 border-b border-zinc-800">
                            <div className="flex items-center gap-3">
                                {selected.logoUrl ? (
                                    <img src={selected.logoUrl} alt={selected.name} className="h-10 w-10 rounded-lg object-contain bg-white/5" />
                                ) : (
                                    <div className="h-10 w-10 rounded-lg bg-zinc-800 flex items-center justify-center text-sm font-bold text-zinc-300">
                                        {selected.name.slice(0, 2).toUpperCase()}
                                    </div>
                                )}
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-base font-semibold text-zinc-100">{selected.name}</h2>
                                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${categoryColor(selected.category)}`}>
                                            {selected.category}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <AuthIcon type={selected.authType} />
                                        <span className="text-xs text-zinc-500 capitalize">{selected.authType.replace('_', ' ')}</span>
                                        {isConnected && (
                                            <>
                                                <span className="text-zinc-700">·</span>
                                                <StatusDot status={connectedItem!.status} />
                                                <span className="text-xs text-emerald-400">Connected</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {selected.docUrl && (
                                    <a
                                        href={selected.docUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors"
                                    >
                                        <ExternalLink className="h-3 w-3" />
                                        Docs
                                    </a>
                                )}
                                {isConnected ? (
                                    <button
                                        onClick={() => void handleDisconnect()}
                                        disabled={disconnecting}
                                        className="flex items-center gap-1.5 rounded-lg border border-red-800/50 bg-red-950/30 px-2.5 py-1.5 text-xs text-red-400 hover:border-red-700 hover:bg-red-950/50 transition-colors disabled:opacity-50"
                                    >
                                        <Trash2 className="h-3 w-3" />
                                        {disconnecting ? 'Removing…' : 'Disconnect'}
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => void handleInstall()}
                                        disabled={installing || !WS_ID}
                                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
                                    >
                                        <Link2 className="h-3.5 w-3.5" />
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
                                            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                                                <dt className="text-zinc-600">Status</dt>
                                                <dd className="flex items-center gap-1.5">
                                                    <StatusDot status={connectedItem.status} />
                                                    <span className="text-zinc-300 capitalize">{connectedItem.status}</span>
                                                </dd>
                                                <dt className="text-zinc-600">Connected</dt>
                                                <dd className="text-zinc-300">{new Date(connectedItem.createdAt).toLocaleDateString()}</dd>
                                                {connectedItem.lastVerifiedAt && (
                                                    <>
                                                        <dt className="text-zinc-600">Last verified</dt>
                                                        <dd className="text-zinc-300">{new Date(connectedItem.lastVerifiedAt).toLocaleDateString()}</dd>
                                                    </>
                                                )}
                                                {connectedItem.scopesGranted.length > 0 && (
                                                    <>
                                                        <dt className="text-zinc-600">Scopes</dt>
                                                        <dd className="text-zinc-300">{connectedItem.scopesGranted.join(', ')}</dd>
                                                    </>
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
                                                    <label className="text-sm font-medium text-zinc-300">
                                                        {field.label} {field.required && <span className="text-red-500">*</span>}
                                                    </label>
                                                    <input
                                                        type={field.type === 'password' ? 'password' : 'text'}
                                                        value={fieldValues[field.key] ?? ''}
                                                        onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                                        placeholder={field.placeholder ?? ''}
                                                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
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
                                                        className={`flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-all disabled:opacity-60 ${enabled
                                                            ? 'border-zinc-700/60 bg-zinc-900/60 hover:border-zinc-600'
                                                            : 'border-zinc-800/40 bg-zinc-900/20 opacity-60 hover:opacity-80'
                                                            }`}
                                                    >
                                                        <div className="flex items-center gap-2.5">
                                                            <Wrench className="h-3.5 w-3.5 text-zinc-600" />
                                                            <span className="text-sm font-mono text-zinc-300">{tool}</span>
                                                        </div>
                                                        {enabled
                                                            ? <ToggleRight className="h-5 w-5 text-indigo-400" />
                                                            : <ToggleLeft className="h-5 w-5 text-zinc-700" />
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
                                                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
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
