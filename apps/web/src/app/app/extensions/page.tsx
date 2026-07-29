// SPDX-License-Identifier: MIT
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
    Circle,
    ToggleLeft,
    ToggleRight,
    Info,
    Bot,
    SearchX,
    ShieldCheck,
    X,
} from 'lucide-react'
import { useWorkspaceId } from '@web/context/workspace'
import { useConfirm } from '@web/components/ui/confirm-dialog'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import { useViewMode } from '@web/hooks/use-view-mode'
import { ViewModeToggle } from '@web/components/view-mode-toggle'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface ExtensionManifest {
    name: string
    version: string
    description?: string
    type: string
    plexo: string
    tools?: Array<{ name: string; description?: string }>
    permissions?: string[]
    capabilities?: string[]
    minHostLevel?: string
    trust?: string
    dataResidency?: { sendsDataExternally: boolean }
}

interface Extension {
    id: string
    name: string
    version: string
    type: string
    pexVersion: string
    enabled: boolean
    installedAt: string
    manifest: ExtensionManifest | null
    settings: Record<string, unknown>
    isFirstParty?: boolean
}

/** All managed extension types including agents */
const TOOL_TYPES = new Set(['skill', 'function', 'channel', 'tool', 'mcp-server', 'agent', 'connector'])

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

function ToolCard({ ext, onToggle, onUninstall }: { ext: Extension; onToggle: (id: string, enabled: boolean) => Promise<void>; onUninstall: (id: string, name: string) => Promise<void> }) {
    const [expanded, setExpanded] = useState(false)
    const [toggling, setToggling] = useState(false)
    const [uninstalling, setUninstalling] = useState(false)
    const { isAdvanced } = useViewMode()
    const manifest = ext.manifest

    async function handleToggle() {
        setToggling(true)
        try {
            await onToggle(ext.id, !ext.enabled)
        } finally {
            setToggling(false)
        }
    }

    const typeBadge = ext.type === 'function' || ext.type === 'tool' ? 'Tool'
        : ext.type === 'channel' ? 'Channel'
        : ext.type === 'mcp-server' ? 'Connector'
        : ext.type === 'connector' ? 'Connector'
        : ext.type === 'skill' ? 'Skill'
        : ext.type === 'agent' ? 'Agent'
        : ext.type

    const badgeStyle = (ext.type === 'function' || ext.type === 'tool')
        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
        : ext.type === 'skill'
            ? 'bg-azure/15 text-azure border-azure/30'
            : ext.type === 'channel'
                ? 'bg-green-500/15 text-green-300 border-green-500/30'
                : (ext.type === 'mcp-server' || ext.type === 'connector')
                    ? 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                    : ext.type === 'agent'
                        ? 'bg-violet-500/15 text-violet-300 border-violet-500/30'
                        : 'bg-surface-2 text-text-muted border-border'

    return (
        <div className={`rounded-sm border transition-all ${ext.enabled
            ? 'border-border/60 bg-surface-1/60'
            : 'border-border/40 bg-surface-1/20 opacity-70'
            }`}>
            <button
                type="button"
                className="flex items-center gap-3 px-4 py-3 w-full text-left cursor-pointer"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Hide' : 'Show'} details for ${ext.name}`}
                onClick={() => setExpanded((e) => !e)}
            >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-sm ${ext.enabled ? 'bg-azure/20' : 'bg-surface-2'}`}>
                    <Zap className={`h-4 w-4 ${ext.enabled ? 'text-azure' : 'text-text-muted'}`} aria-hidden="true" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground truncate">{ext.name}</span>
                        <span className="text-[11px] font-mono text-muted-foreground shrink-0">v{ext.version}</span>
                        <span className={`text-[10px] font-medium uppercase tracking-wide rounded-sm border px-1.5 py-0.5 shrink-0 ${badgeStyle}`}>{typeBadge}</span>
                        {ext.isFirstParty && (
                            <span className="flex items-center gap-0.5 text-[10px] font-medium uppercase tracking-wide rounded-sm border border-signal-green/30 bg-signal-green/10 text-emerald-400 px-1.5 py-0.5 shrink-0">
                                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                                Official
                            </span>
                        )}
                        {ext.settings?.isGenerated === true && (
                            <span className="text-[11px] font-medium text-azure border border-azure/30 rounded px-1.5 py-0.5 shrink-0">
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
                        aria-label={toggling ? `Updating ${ext.name}…` : `${ext.enabled ? 'Disable' : 'Enable'} ${ext.name}`}
                        aria-busy={toggling}
                        className="flex items-center gap-1 rounded-sm border border-border px-2.5 py-1 text-xs transition-colors hover:border-border disabled:opacity-40"
                    >
                        {toggling ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin text-text-muted" aria-hidden="true" />
                        ) : ext.enabled ? (
                            <><ToggleRight className="h-4 w-4 text-azure" aria-hidden="true" /><span className="text-azure">Enabled</span></>
                        ) : (
                            <><ToggleLeft className="h-4 w-4 text-text-muted" aria-hidden="true" /><span className="text-text-muted">Disabled</span></>
                        )}
                    </button>
                    {expanded
                        ? <ChevronDown className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
                        : <ChevronRight className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
                    }
                </div>
            </button>

            {expanded && (
                <div className="border-t border-border px-4 py-3 flex flex-col gap-3">
                    {ext.isFirstParty && (
                        <div className="flex items-center justify-between rounded-sm border border-signal-green/20 bg-signal-green/5 px-3 py-2">
                            <div className="flex items-center gap-2">
                                <Circle className={`h-2 w-2 shrink-0 ${ext.enabled ? 'fill-emerald-400 text-emerald-400' : 'fill-muted-foreground text-muted-foreground'}`} aria-hidden="true" />
                                <span className="text-[11px] font-medium text-foreground">
                                    {ext.enabled ? 'Connected' : 'Disconnected'}
                                </span>
                                {manifest?.tools && (
                                    <span className="text-[11px] text-muted-foreground">
                                        {manifest.tools.length} tool{manifest.tools.length !== 1 ? 's' : ''} declared
                                    </span>
                                )}
                            </div>
                            <a
                                href={`https://getplexo.com/apps/${ext.name.replace('@joeybuilt/', '')}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] font-medium text-emerald-400 hover:underline"
                                onClick={(e) => e.stopPropagation()}
                            >
                                View App
                            </a>
                        </div>
                    )}
                    {isAdvanced && (manifest?.capabilities ?? []).length > 0 && (
                        <div>
                            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1.5">Capabilities</p>
                            <div className="flex flex-wrap gap-1">
                                {manifest!.capabilities!.map((p) => (
                                    <span key={p} className="rounded border border-amber-800/40 bg-amber-dim px-2 py-0.5 text-[11px] font-mono text-amber">{p}</span>
                                ))}
                            </div>
                        </div>
                    )}
                    {isAdvanced && (() => {
                        const entityGroups = groupEntityCapabilities(manifest?.capabilities ?? [])
                        if (entityGroups.length === 0) return null
                        return (
                            <div>
                                <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1.5">Entity Access</p>
                                <div className="flex flex-wrap gap-2">
                                    {entityGroups.map(g => (
                                        <span key={g.entity} className="rounded border border-azure-800/30 bg-azure/10 px-2 py-0.5 text-[11px] text-azure">
                                            {g.entity}: {g.ops.join(' · ')}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )
                    })()}
                    {isAdvanced && manifest?.trust && (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            <span>Trust tier: <span className="text-text-secondary font-medium">{manifest.trust}</span></span>
                        </div>
                    )}
                    {isAdvanced && manifest?.dataResidency && (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            <span>Data residency: <span className="text-text-secondary">{manifest.dataResidency.sendsDataExternally ? 'Sends data externally' : 'Local only'}</span></span>
                        </div>
                    )}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4 text-[11px] text-text-muted">
                            <span>Installed {new Date(ext.installedAt).toLocaleDateString()}</span>
                            {isAdvanced && manifest?.minHostLevel && <span>Requires host level: <span className="text-text-secondary">{manifest.minHostLevel}</span></span>}
                        </div>
                        <button
                            type="button"
                            onClick={async (e) => {
                                e.stopPropagation()
                                setUninstalling(true)
                                try { await onUninstall(ext.id, ext.name) } finally { setUninstalling(false) }
                            }}
                            disabled={uninstalling}
                            aria-label={uninstalling ? `Uninstalling ${ext.name}…` : `Uninstall ${ext.name}`}
                            aria-busy={uninstalling}
                            className="flex items-center gap-1 rounded-sm border border-red-800/40 px-2.5 py-1 text-[11px] font-medium text-red hover:bg-red/10 transition-colors disabled:opacity-40"
                        >
                            {uninstalling ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ZapOff className="h-3 w-3" />}
                            Uninstall
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

export default function ToolsPage() {
    const WS_ID = useWorkspaceId()
    const confirmAction = useConfirm()
    const [extensions, setExtensions] = useState<Extension[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const lf = useListFilter(['status', 'type'], 'name_asc')
    const { search, filterValues, clearAll } = lf

    const fetchTools = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/extensions?workspaceId=${WS_ID}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json() as { items: Extension[] }
            setExtensions(data.items)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load extensions')
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchTools() }, [fetchTools])

    async function handleToggle(id: string, enabled: boolean) {
        try {
            const res = await fetch(`${API_BASE}/api/v1/extensions/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            })
            if (res.ok) {
                setExtensions((prev) => prev.map((p) => p.id === id ? { ...p, enabled } : p))
            } else {
                setError(`Failed to ${enabled ? 'enable' : 'disable'} extension`)
            }
        } catch {
            setError(`Network error — could not ${enabled ? 'enable' : 'disable'} extension`)
        }
    }

    async function handleUninstall(id: string, name: string) {
        const ext = extensions.find(e => e.id === id)
        const typeLabel = ext?.type === 'skill' ? 'skill' : ext?.type === 'channel' ? 'channel' : (ext?.type === 'mcp-server' || ext?.type === 'connector') ? 'connector' : 'tool'
        if (!await confirmAction({ title: `Uninstall ${typeLabel}`, description: `Uninstall "${name}"? Any capabilities it provides will stop working.`, confirmLabel: 'Uninstall', variant: 'danger' })) return
        const res = await fetch(`${API_BASE}/api/v1/extensions/${id}?workspaceId=${WS_ID}`, { method: 'DELETE' })
        if (res.ok) {
            setExtensions((prev) => prev.filter((p) => p.id !== id))
        } else {
            setError(`Failed to uninstall "${name}"`)
        }
    }

    // Show all non-agent tools
    const filteredByType = extensions.filter(
        (p) => TOOL_TYPES.has(p.type)
    )

    const filteredTools = filteredByType.filter((p) => {
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
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="text-2xl font-medium tracking-tight text-text-primary">Extensions</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        Manage all installed extensions — skills, tools, agents, channels, and connectors.
                    </p>
                </div>
                <div className="flex items-center flex-wrap gap-2 shrink-0">
                    <ViewModeToggle />
                    <button
                    onClick={() => void fetchTools()}
                    disabled={loading}
                    aria-label="Refresh extensions"
                    title="Refresh"
                    className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
                    <span className="hidden sm:inline">Refresh</span>
                </button>
                </div>
            </div>

            {/* Agent context banner */}
            <div className="rounded-sm border border-border/50 bg-surface-1/30 px-4 py-3 flex items-center gap-3">
                <Bot className="h-4 w-4 text-text-muted shrink-0" aria-hidden="true" />
                <p className="text-xs text-text-muted flex-1">
                    Agent extensions are managed here alongside other extensions. To configure your primary agent (personality, model, limits), visit the agent settings page.
                </p>
                <a href="/app/agents" className="text-xs font-medium text-azure hover:underline shrink-0">
                    Your Agent →
                </a>
            </div>

            {/* Info banner */}
            <div className="rounded-sm border border-border/50 bg-surface-1/30 px-4 py-3 flex items-start gap-3">
                <Info className="h-4 w-4 text-text-muted shrink-0 mt-0.5" aria-hidden="true" />
                <div className="space-y-1.5">
                    <p className="text-xs font-medium text-text-secondary">
                        Extensions add capabilities to your agent. Install from the Hub, then enable here.
                    </p>
                    <div className="grid gap-1 text-[11px] text-text-muted">
                        <span><span className="font-medium text-text-secondary">Skills</span> — operating instructions: playbooks, checklists, workflows</span>
                        <span><span className="font-medium text-text-secondary">Tools</span> — executable actions: PDF generation, image processing, data transforms</span>
                        <span><span className="font-medium text-text-secondary">Channels</span> — communication endpoints: how you talk to Plexo</span>
                        <span><span className="font-medium text-text-secondary">Connectors</span> — external service bridges: Notion, Stripe, GitHub, Slack</span>
                    </div>
                </div>
            </div>

            {error && (
                <div role="alert" className="rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 flex items-center gap-2 text-xs text-red">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className="flex-1">{error}</span>
                    <button
                        type="button"
                        onClick={() => setError(null)}
                        aria-label="Dismiss error"
                        className="shrink-0 p-0.5 rounded hover:bg-red/20 transition-colors"
                    >
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
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
                            { value: 'enabled', label: 'Enabled', dimmed: filteredByType.every((p) => !p.enabled) },
                            { value: 'disabled', label: 'Disabled', dimmed: filteredByType.every((p) => p.enabled) },
                        ],
                    },
                    {
                        key: 'type',
                        label: 'Type',
                        options: [
                            { value: 'function', label: 'Tool' },
                            { value: 'tool', label: 'Tool' },
                            { value: 'agent', label: 'Agent' },
                            { value: 'channel', label: 'Channel' },
                            { value: 'mcp-server', label: 'Connector' },
                            { value: 'connector', label: 'Connector' },
                            { value: 'skill', label: 'Skill' },
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
                <div className="flex items-center justify-center gap-2 py-16 text-sm text-text-muted">
                    <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Loading extensions…
                </div>
            ) : filteredByType.length === 0 ? (
                <div role="status" aria-live="polite" className="rounded-sm border border-border bg-surface-1/40 p-12 text-center">
                    <ZapOff className="h-10 w-10 text-text-muted mx-auto mb-3" aria-hidden="true" />
                    <p className="text-sm font-medium text-text-secondary">No extensions installed</p>
                    <p className="text-xs text-text-muted mt-1">
                        Visit the <a href="/app/hub" className="text-azure hover:underline">Hub</a> to browse available extensions.
                    </p>
                </div>
            ) : filteredTools.length === 0 ? (
                <div role="status" aria-live="polite" className="rounded-sm border border-border bg-surface-1/40 p-12 text-center">
                    <SearchX className="h-10 w-10 text-text-muted mx-auto mb-3" aria-hidden="true" />
                    <p className="text-sm font-medium text-text-secondary">No results match your filters</p>
                    <button type="button" onClick={clearAll} className="mt-3 flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors mx-auto">
                        <X className="h-3.5 w-3.5" /> Clear filters
                    </button>
                </div>
            ) : (() => {
                const officialApps = filteredTools.filter((p) => p.isFirstParty)
                const communityExts = filteredTools.filter((p) => !p.isFirstParty)
                return (
                    <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between mb-1">
                            <p className="text-xs text-muted-foreground">{filteredByType.filter((p) => p.enabled).length} / {filteredByType.length} enabled</p>
                        </div>

                        {officialApps.length > 0 && (
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2">
                                    <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
                                    <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Official Apps</h2>
                                </div>
                                {officialApps.map((p) => (
                                    <ToolCard key={p.id} ext={p} onToggle={handleToggle} onUninstall={handleUninstall} />
                                ))}
                            </div>
                        )}

                        {communityExts.length > 0 && (
                            <div className="flex flex-col gap-2">
                                {officialApps.length > 0 && (
                                    <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mt-2">Installed Extensions</h2>
                                )}
                                {communityExts.map((p) => (
                                    <ToolCard key={p.id} ext={p} onToggle={handleToggle} onUninstall={handleUninstall} />
                                ))}
                            </div>
                        )}
                    </div>
                )
            })()}
        </div>
    )
}
