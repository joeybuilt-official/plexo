// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback } from 'react'
import {
    Zap,
    ZapOff,
    RefreshCw,
    AlertCircle,
    Package,
    ChevronDown,
    ChevronRight,
    ToggleLeft,
    ToggleRight,
    Info,
    Bot,
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
    tools?: Array<{ name: string; description?: string }>
    permissions?: string[]
    capabilities?: string[]
    minHostLevel?: string
    trust?: string
    dataResidency?: { sendsDataExternally: boolean }
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

/** Extension types — everything except 'agent' (agents have their own section) */
const EXTENSION_TYPES = new Set(['skill', 'function', 'channel', 'tool', 'mcp-server'])

function groupEntityCapabilities(caps: string[]): { entity: string; ops: string[] }[] {
    const entityCaps = caps.filter(c => /^memory:(read|write):[a-z_]+$/.test(c) && c !== 'memory:read:*' && c !== 'memory:write:*')
    const grouped: Record<string, Set<string>> = {}
    for (const cap of entityCaps) {
        const [, op, entity] = cap.split(':')
        if (!grouped[entity!]) grouped[entity!] = new Set()
        grouped[entity!]!.add(op!)
    }
    return Object.entries(grouped).map(([entity, ops]) => ({
        entity: entity.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()),
        ops: [...ops].sort(),
    }))
}

function ExtensionCard({ plugin, onToggle }: { plugin: Plugin; onToggle: (id: string, enabled: boolean) => Promise<void> }) {
    const [expanded, setExpanded] = useState(false)
    const [toggling, setToggling] = useState(false)
    const manifest = plugin.manifest

    async function handleToggle() {
        setToggling(true)
        try {
            await onToggle(plugin.id, !plugin.enabled)
        } finally {
            setToggling(false)
        }
    }

    const typeBadge = plugin.type === 'function' || plugin.type === 'tool' ? 'Function'
        : plugin.type === 'channel' ? 'Channel'
        : plugin.type === 'mcp-server' ? 'MCP Server'
        : plugin.type === 'skill' ? 'Extension'
        : plugin.type

    return (
        <div className={`rounded-xl border transition-all ${plugin.enabled
            ? 'border-border/60 bg-surface-1/60'
            : 'border-border/40 bg-surface-1/20 opacity-70'
            }`}>
            <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                onClick={() => setExpanded((e) => !e)}
            >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${plugin.enabled ? 'bg-azure/20' : 'bg-surface-2'}`}>
                    <Zap className={`h-4 w-4 ${plugin.enabled ? 'text-azure' : 'text-text-muted'}`} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">{plugin.name}</span>
                        <span className="text-[10px] font-mono text-text-muted shrink-0">v{plugin.version}</span>
                        <span className="text-[10px] rounded border border-border px-1.5 py-0.5 text-text-muted shrink-0">{typeBadge}</span>
                        {plugin.settings?.isGenerated === true && (
                            <span className="text-[10px] font-medium text-azure border border-azure/30 rounded px-1.5 py-0.5 shrink-0">
                                ✦ Custom
                            </span>
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
                        ) : plugin.enabled ? (
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
                    {(manifest?.capabilities ?? []).length > 0 && (
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">Capabilities</p>
                            <div className="flex flex-wrap gap-1">
                                {manifest!.capabilities!.map((p) => (
                                    <span key={p} className="rounded border border-amber-800/40 bg-amber-950/20 px-2 py-0.5 text-[10px] font-mono text-amber">{p}</span>
                                ))}
                            </div>
                        </div>
                    )}
                    {(() => {
                        const entityGroups = groupEntityCapabilities(manifest?.capabilities ?? [])
                        if (entityGroups.length === 0) return null
                        return (
                            <div>
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">Entity Access</p>
                                <div className="flex flex-wrap gap-2">
                                    {entityGroups.map(g => (
                                        <span key={g.entity} className="rounded border border-azure-800/30 bg-azure/10 px-2 py-0.5 text-[10px] text-azure">
                                            {g.entity}: {g.ops.join(' · ')}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )
                    })()}
                    {manifest?.trust && (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            <span>Trust tier: <span className="text-text-secondary font-medium">{manifest.trust}</span></span>
                        </div>
                    )}
                    {manifest?.dataResidency && (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            <span>Data residency: <span className="text-text-secondary">{manifest.dataResidency.sendsDataExternally ? 'Sends data externally' : 'Local only'}</span></span>
                        </div>
                    )}
                    <div className="flex items-center gap-4 text-[11px] text-text-muted">
                        <span>Installed {new Date(plugin.installedAt).toLocaleDateString()}</span>
                        <span>Fabric {plugin.fabricVersion}</span>
                        {manifest?.minHostLevel && <span>Requires host level: <span className="text-text-secondary">{manifest.minHostLevel}</span></span>}
                    </div>
                </div>
            )}
        </div>
    )
}

export default function ExtensionsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [plugins, setPlugins] = useState<Plugin[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const lf = useListFilter(['status', 'type'], 'name_asc')
    const { search, filterValues, clearAll } = lf

    const fetchPlugins = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/extensions?workspaceId=${WS_ID}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json() as { items: Plugin[] }
            setPlugins(data.items)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load extensions')
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchPlugins() }, [fetchPlugins])

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

    // Show all non-agent extensions
    const extensionPlugins = plugins.filter(
        (p) => EXTENSION_TYPES.has(p.type)
    )

    const filteredPlugins = extensionPlugins.filter((p) => {
        const matchStatus = (() => {
            if (!filterValues.status) return true
            if (filterValues.status === 'enabled') return p.enabled
            if (filterValues.status === 'disabled') return !p.enabled
            return true
        })()
        if (!matchStatus) return false
        const matchType = (() => {
            if (!filterValues.type) return true
            return p.type === filterValues.type
        })()
        if (!matchType) return false
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return (
            p.name.toLowerCase().includes(q) ||
            p.manifest?.description?.toLowerCase().includes(q)
        )
    }).sort((a, b) => {
        if (lf.sort === 'name_desc') return b.name.localeCompare(a.name)
        if (lf.sort === 'enabled_first') return (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0)
        if (lf.sort === 'disabled_first') return (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0)
        return a.name.localeCompare(b.name)
    })

    return (
        <div className="flex flex-col gap-6 max-w-4xl">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-zinc-50">Extensions</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        Fabric extensions — capability packages the agent can invoke
                    </p>
                </div>
                <button
                    onClick={() => void fetchPlugins()}
                    disabled={loading}
                    title="Refresh"
                    className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">Refresh</span>
                </button>
            </div>

            {/* Agent redirect banner */}
            <div className="rounded-xl border border-border/50 bg-surface-1/30 px-4 py-3 flex items-center gap-3">
                <Bot className="h-4 w-4 text-text-muted shrink-0" />
                <p className="text-xs text-text-muted flex-1">
                    Looking for agents? Agents have their own dedicated section.
                </p>
                <a href="/agents" className="text-xs font-medium text-azure hover:underline shrink-0">
                    View Agents →
                </a>
            </div>

            {/* Info banner */}
            <div className="rounded-xl border border-azure-800/30 bg-azure/20 px-4 py-3 flex items-start gap-3">
                <Info className="h-4 w-4 text-azure shrink-0 mt-0.5" />
                <div>
                    <p className="text-xs font-medium text-azure mb-0.5">Plexo Fabric Extensions</p>
                    <p className="text-xs text-azure/70">
                        Extensions are capability packages — functions, channels, and MCP servers — that grant the agent new abilities.
                        Install via the Marketplace, then enable here. Each extension declares capabilities and data residency via its <code className="text-azure">plexo.json</code> manifest.
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
                placeholder="Search extensions..."
                dimensions={[
                    {
                        key: 'status',
                        label: 'Status',
                        options: [
                            { value: 'enabled', label: 'Enabled', dimmed: extensionPlugins.every((p) => !p.enabled) },
                            { value: 'disabled', label: 'Disabled', dimmed: extensionPlugins.every((p) => p.enabled) },
                        ],
                    },
                    {
                        key: 'type',
                        label: 'Type',
                        options: [
                            { value: 'function', label: 'Function' },
                            { value: 'channel', label: 'Channel' },
                            { value: 'mcp-server', label: 'MCP Server' },
                        ],
                    },
                ]}
                sortOptions={[
                    { label: 'Name: A → Z', value: 'name_asc' },
                    { label: 'Name: Z → A', value: 'name_desc' },
                    { label: 'Enabled first', value: 'enabled_first' },
                    { label: 'Disabled first', value: 'disabled_first' },
                ]}
            />

            {loading ? (
                <div className="flex items-center justify-center py-16">
                    <RefreshCw className="h-5 w-5 text-text-muted animate-spin" />
                </div>
            ) : extensionPlugins.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <ZapOff className="h-10 w-10 text-zinc-700" />
                    <div className="text-center">
                        <p className="text-sm font-medium text-text-muted">No extensions installed</p>
                        <p className="text-xs text-text-muted mt-1">
                            Install extensions from the <a href="/marketplace" className="text-azure hover:underline">Marketplace</a> to extend the agent.
                        </p>
                    </div>
                </div>
            ) : filteredPlugins.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-12 text-center">
                    <p className="text-sm text-text-muted">No results match your filters.</p>
                    <button onClick={clearAll} className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto">
                        Clear search
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-text-muted">{extensionPlugins.filter((p) => p.enabled).length} / {extensionPlugins.length} enabled</p>
                    </div>
                    {filteredPlugins.map((p) => (
                        <ExtensionCard key={p.id} plugin={p} onToggle={handleToggle} />
                    ))}
                </div>
            )}
        </div>
    )
}
