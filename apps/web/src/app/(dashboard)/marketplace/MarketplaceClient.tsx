// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useTransition, useMemo } from 'react'
import { Package, Puzzle, CheckCircle2, AlertCircle, ToggleLeft, ToggleRight, RefreshCw, Layers } from 'lucide-react'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RegistryItem {
    id: string
    name: string
    description: string
    category: string
    logo_url: string | null
    auth_type: string
    oauth_scopes: string[]
    setup_fields: Array<{ key: string; label: string; type: string }>
    tools_provided: string[]
    cards_provided: string[]
    is_core: boolean
    is_generated?: boolean
    doc_url: string | null
}

interface InstalledItem {
    id: string
    registryId: string
    name: string
    status: 'active' | 'error' | 'expired' | 'disconnected'
}

interface KapselPlugin {
    id: string
    workspaceId: string
    name: string
    displayName: string
    description: string
    version: string
    type: string
    enabled: boolean
    installedAt: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

const CATEGORY_LABELS: Record<string, string> = {
    code: 'Code',
    communication: 'Communication',
    ai: 'AI',
    'project-management': 'Project Management',
    knowledge: 'Knowledge',
    ops: 'Ops',
    observability: 'Observability',
    hosting: 'Hosting',
    storage: 'Storage',
    finance: 'Finance',
    infrastructure: 'Infrastructure',
}

const PLUGIN_TYPE_LABELS: Record<string, string> = {
    agent: 'Agent',
    skill: 'Skill',
    channel: 'Channel',
    tool: 'Tool',
    'mcp-server': 'MCP Server',
}

const STATUS_DOT: Record<string, string> = {
    active: 'bg-emerald',
    error: 'bg-red',
    expired: 'bg-amber',
    disconnected: 'bg-zinc-500',
}

const PLUGIN_TYPE_COLOR: Record<string, string> = {
    agent: 'bg-violet-500/15 text-violet-400 border border-violet-500/30',
    skill: 'bg-blue-500/15 text-blue-400 border border-blue-500/30',
    channel: 'bg-emerald/15 text-emerald border border-emerald-500/30',
    tool: 'bg-amber/15 text-amber border border-amber-500/30',
    'mcp-server': 'bg-rose-500/15 text-rose-400 border border-rose-500/30',
}

// ── Integration Card ──────────────────────────────────────────────────────────

function IntegrationCard({
    item,
    installed,
    workspaceId,
    onInstall,
    onUninstall,
}: {
    item: RegistryItem
    installed: InstalledItem | null
    workspaceId: string
    onInstall: (item: RegistryItem, creds: Record<string, string>) => Promise<void>
    onUninstall: (id: string) => Promise<void>
}) {
    const [open, setOpen] = useState(false)
    const [creds, setCreds] = useState<Record<string, string>>({})
    const [pending, startTransition] = useTransition()
    const [installError, setInstallError] = useState<string | null>(null)

    const hasSetupFields = (item.setup_fields ?? []).length > 0

    function handleInstall() {
        setInstallError(null)
        startTransition(async () => {
            try {
                await onInstall(item, creds)
                setOpen(false)
                setCreds({})
            } catch (err: unknown) {
                setInstallError(err instanceof Error ? err.message : 'Install failed')
            }
        })
    }

    function handleUninstall() {
        if (!installed) return
        startTransition(async () => { await onUninstall(installed.id) })
    }

    return (
        <div className="flex flex-col rounded-xl border border-border bg-surface-1/60 p-5 gap-4 transition-colors hover:border-border">
            <div className="flex items-start gap-3">
                {item.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.logo_url} alt={item.name} className="h-8 w-8 rounded object-contain bg-white p-0.5" />
                ) : (
                    <div className="h-8 w-8 rounded bg-zinc-700 flex items-center justify-center text-xs font-bold text-text-secondary">
                        {item.name[0]}
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-text-primary truncate">{item.name}</h3>
                        {item.is_core && (
                            <span className="shrink-0 rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo border border-indigo/30">
                                Core
                            </span>
                        )}
                        {item.is_generated && (
                            <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-400 border border-violet-500/30">
                                ✦ Custom
                            </span>
                        )}
                    </div>
                    <p className="mt-0.5 text-xs text-text-muted line-clamp-2">{item.description}</p>
                </div>
            </div>

            {/* Tools */}
            <div className="flex flex-wrap gap-1">
                {(item.tools_provided ?? []).slice(0, 4).map((t) => (
                    <span key={t} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-text-secondary">
                        {t}
                    </span>
                ))}
                {(item.tools_provided ?? []).length > 4 && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-text-muted">
                        +{(item.tools_provided ?? []).length - 4}
                    </span>
                )}
            </div>

            {/* Action */}
            {installed ? (
                <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[installed.status] ?? 'bg-zinc-500'}`} />
                        {installed.status}
                    </span>
                    <button
                        onClick={handleUninstall}
                        disabled={pending}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-red-800 hover:text-red transition-colors disabled:opacity-40"
                    >
                        {pending ? 'Removing…' : 'Remove'}
                    </button>
                </div>
            ) : (
                <div>
                    {hasSetupFields && open && (
                        <div className="mb-3 flex flex-col gap-2">
                            {(item.setup_fields ?? []).map((field) => (
                                <div key={field.key}>
                                    <label className="text-[10px] text-text-muted uppercase tracking-wide">{field.label}</label>
                                    <input
                                        type={field.type === 'password' ? 'password' : 'text'}
                                        value={creds[field.key] ?? ''}
                                        onChange={(e) => setCreds((p) => ({ ...p, [field.key]: e.target.value }))}
                                        className="mt-0.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus:border-indigo focus:outline-none"
                                        placeholder={`Enter ${field.label.toLowerCase()}`}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                    {installError && (
                        <p className="mb-2 text-[11px] text-red flex items-center gap-1">
                            <AlertCircle className="h-3 w-3" />{installError}
                        </p>
                    )}
                    <button
                        onClick={hasSetupFields ? (open ? handleInstall : () => setOpen(true)) : handleInstall}
                        disabled={pending}
                        className="w-full rounded-lg bg-indigo px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-indigo/90 transition-colors disabled:opacity-40"
                    >
                        {pending ? 'Installing…' : hasSetupFields && !open ? 'Configure' : 'Install'}
                    </button>
                </div>
            )}
        </div>
    )
}

// ── Extension Card (Kapsel) ───────────────────────────────────────────────────

function ExtensionCard({
    plugin,
    workspaceId,
    onToggle,
    onUninstall,
}: {
    plugin: KapselPlugin
    workspaceId: string
    onToggle: (id: string, enabled: boolean) => Promise<void>
    onUninstall: (id: string) => Promise<void>
}) {
    const [pending, startTransition] = useTransition()

    function handleToggle() {
        startTransition(async () => { await onToggle(plugin.id, !plugin.enabled) })
    }
    function handleUninstall() {
        startTransition(async () => { await onUninstall(plugin.id) })
    }

    const typeColor = PLUGIN_TYPE_COLOR[plugin.type] ?? 'bg-surface-2 text-text-secondary border border-border'
    const typeLabel = PLUGIN_TYPE_LABELS[plugin.type] ?? plugin.type

    return (
        <div className="flex flex-col rounded-xl border border-border bg-surface-1/60 p-5 gap-4 transition-colors hover:border-border">
            <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded bg-surface-2 flex items-center justify-center text-sm">
                    <Puzzle className="h-4 w-4 text-text-secondary" />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold text-text-primary truncate">{plugin.displayName || plugin.name}</h3>
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${typeColor}`}>
                            {typeLabel}
                        </span>
                    </div>
                    <p className="mt-0.5 text-xs text-text-muted line-clamp-2">{plugin.description || 'No description'}</p>
                </div>
            </div>

            <div className="flex items-center gap-2 text-[10px] text-text-muted">
                <span className="font-mono">{plugin.name}</span>
                <span>·</span>
                <span>v{plugin.version}</span>
                <span>·</span>
                <span>installed {new Date(plugin.installedAt).toLocaleDateString()}</span>
            </div>

            <div className="flex items-center justify-between">
                <button
                    onClick={handleToggle}
                    disabled={pending}
                    className={`flex items-center gap-1.5 text-xs transition-colors disabled:opacity-40 ${plugin.enabled ? 'text-emerald' : 'text-text-muted'}`}
                >
                    {pending
                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        : plugin.enabled
                            ? <ToggleRight className="h-4 w-4" />
                            : <ToggleLeft className="h-4 w-4" />
                    }
                    {plugin.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button
                    onClick={handleUninstall}
                    disabled={pending}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-red-800 hover:text-red transition-colors disabled:opacity-40"
                >
                    Uninstall
                </button>
            </div>
        </div>
    )
}

// ── Integrations tab ──────────────────────────────────────────────────────────

function IntegrationsTab({
    registry,
    installed: initialInstalled,
    workspaceId,
}: {
    registry: RegistryItem[]
    installed: InstalledItem[]
    workspaceId: string
}) {
    const [installed, setInstalled] = useState(initialInstalled)

    const lf = useListFilter(['category'], 'name_asc')

    const filtered = useMemo(() => {
        let out = [...registry]

        if (lf.filterValues.category) {
            out = out.filter((r) => r.category === lf.filterValues.category)
        }

        if (lf.search.trim()) {
            const q = lf.search.toLowerCase()
            out = out.filter((r) =>
                r.name.toLowerCase().includes(q) ||
                (r.description || '').toLowerCase().includes(q)
            )
        }

        out.sort((a, b) => {
            if (lf.sort === 'name_desc') return b.name.localeCompare(a.name)
            if (lf.sort === 'installed_first') {
                const aInst = installed.some((i) => i.registryId === a.id) ? 1 : 0
                const bInst = installed.some((i) => i.registryId === b.id) ? 1 : 0
                return bInst - aInst || a.name.localeCompare(b.name)
            }
            return a.name.localeCompare(b.name)
        })

        return out
    }, [registry, installed, lf.search, lf.filterValues.category, lf.sort])

    const availableCategories = useMemo(() => new Set(registry.map(r => r.category)), [registry])

    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'category',
            label: 'Category',
            options: Array.from(availableCategories).sort().map((cat) => ({
                value: cat,
                label: CATEGORY_LABELS[cat] ?? cat,
                icon: <Layers className="h-3 w-3 mr-1 shrink-0 text-text-muted" />,
                dimmed: !availableCategories.has(cat),
            })),
        },
    ], [availableCategories])

    async function handleInstall(item: RegistryItem, creds: Record<string, string>) {
        const res = await fetch(`${API_BASE}/api/v1/connections/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, registryId: item.id, credentials: creds }),
        })
        if (res.ok) {
            const data = await res.json() as { id: string }
            setInstalled((prev) => [...prev, { id: data.id, registryId: item.id, name: item.name, status: 'active' }])
        } else {
            const err = await res.json().catch(() => ({}))
            throw new Error((err as { error?: { message?: string } }).error?.message ?? 'Install failed')
        }
    }

    async function handleUninstall(id: string) {
        await fetch(`${API_BASE}/api/v1/connections/installed/${id}?workspaceId=${workspaceId}`, { method: 'DELETE' })
        setInstalled((prev) => prev.filter((i) => i.id !== id))
    }

    return (
        <div className="flex flex-col gap-5">
            <ListToolbar
                hook={lf}
                placeholder="Search integrations…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Name: A → Z', value: 'name_asc' },
                    { label: 'Name: Z → A', value: 'name_desc' },
                    { label: 'Installed first', value: 'installed_first' },
                ]}
            />

            <div className="flex items-center gap-4 text-xs text-text-muted">
                <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-emerald" />{installed.length} connected</span>
                <span>{filtered.length} available</span>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((item) => (
                    <IntegrationCard
                        key={item.id}
                        item={item}
                        installed={installed.find((i) => i.registryId === item.id) ?? null}
                        workspaceId={workspaceId}
                        onInstall={handleInstall}
                        onUninstall={handleUninstall}
                    />
                ))}
            </div>
        </div>
    )
}

// ── Extensions tab (Kapsel) ───────────────────────────────────────────────────

function ExtensionsTab({
    plugins: initialPlugins,
    workspaceId,
}: {
    plugins: KapselPlugin[]
    workspaceId: string
}) {
    const [plugins, setPlugins] = useState<KapselPlugin[]>(
        Array.isArray(initialPlugins) ? initialPlugins : []
    )

    const lf = useListFilter(['type'], 'name_asc')

    const filtered = useMemo(() => {
        let out = [...plugins]

        if (lf.filterValues.type) {
            out = out.filter((p) => p.type === lf.filterValues.type)
        }

        if (lf.search.trim()) {
            const q = lf.search.toLowerCase()
            out = out.filter((p) =>
                p.name.toLowerCase().includes(q) ||
                p.displayName.toLowerCase().includes(q) ||
                (p.description || '').toLowerCase().includes(q)
            )
        }

        out.sort((a, b) => {
            if (lf.sort === 'name_desc') return b.displayName.localeCompare(a.displayName)
            if (lf.sort === 'enabled_first') {
                return (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0) || a.displayName.localeCompare(b.displayName)
            }
            if (lf.sort === 'disabled_first') {
                return (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0) || a.displayName.localeCompare(b.displayName)
            }
            return a.displayName.localeCompare(b.displayName)
        })

        return out
    }, [plugins, lf.search, lf.filterValues.type, lf.sort])

    const availableTypes = useMemo(() => new Set(plugins.map(p => p.type)), [plugins])

    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'type',
            label: 'Extension Type',
            options: Array.from(availableTypes).sort().map((t) => ({
                value: t,
                label: PLUGIN_TYPE_LABELS[t] ?? t,
                icon: <Puzzle className="h-3 w-3 mr-1 shrink-0 text-text-muted" />,
                dimmed: !availableTypes.has(t),
            })),
        },
    ], [availableTypes])

    async function handleToggle(id: string, enabled: boolean) {
        const res = await fetch(`${API_BASE}/api/v1/plugins/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, workspaceId }),
        })
        if (res.ok) {
            setPlugins((prev) => prev.map((p) => p.id === id ? { ...p, enabled } : p))
        }
    }

    async function handleUninstall(id: string) {
        const res = await fetch(`${API_BASE}/api/v1/plugins/${id}?workspaceId=${workspaceId}`, { method: 'DELETE' })
        if (res.ok) setPlugins((prev) => prev.filter((p) => p.id !== id))
    }

    if (plugins.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
                <div className="h-12 w-12 rounded-xl bg-surface-2 flex items-center justify-center">
                    <Puzzle className="h-5 w-5 text-text-muted" />
                </div>
                <div>
                    <p className="text-sm font-medium text-text-secondary">No extensions installed</p>
                    <p className="mt-1 text-xs text-text-muted max-w-xs">
                        Extensions are Kapsel-standard packages that add new capabilities — custom tools, MCP servers, agent skills, and more.
                    </p>
                </div>
                <a
                    href="https://kapsel.dev"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-indigo hover:text-indigo-300 underline underline-offset-2"
                >
                    Browse the Kapsel registry →
                </a>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-5">
            <ListToolbar
                hook={lf}
                placeholder="Search extensions…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Name: A → Z', value: 'name_asc' },
                    { label: 'Name: Z → A', value: 'name_desc' },
                    { label: 'Enabled first', value: 'enabled_first' },
                    { label: 'Disabled first', value: 'disabled_first' },
                ]}
            />

            <div className="flex items-center gap-4 text-xs text-text-muted">
                <span>{plugins.length} installed</span>
                <span className="text-emerald">{plugins.filter(p => p.enabled).length} active</span>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((plugin) => (
                    <ExtensionCard
                        key={plugin.id}
                        plugin={plugin}
                        workspaceId={workspaceId}
                        onToggle={handleToggle}
                        onUninstall={handleUninstall}
                    />
                ))}
            </div>
        </div>
    )
}

// ── Root component ─────────────────────────────────────────────────────────────

type Tab = 'integrations' | 'extensions'

export default function MarketplaceClient({
    registry,
    installed,
    plugins,
    workspaceId,
}: {
    registry: RegistryItem[]
    installed: InstalledItem[]
    plugins: KapselPlugin[]
    workspaceId: string
}) {
    const [tab, setTab] = useState<Tab>('integrations')

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Marketplace</h1>
                <p className="mt-0.5 text-sm text-text-muted">
                    Discover and manage integrations and extensions that extend what the agent can do.
                </p>
            </div>

            {/* Tabs */}
            <div className="flex gap-0 border-b border-border">
                <button
                    onClick={() => setTab('integrations')}
                    className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === 'integrations'
                        ? 'border-indigo text-indigo'
                        : 'border-transparent text-text-muted hover:text-text-secondary'
                        }`}
                >
                    <Package className="h-3.5 w-3.5" />
                    Integrations
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${tab === 'integrations' ? 'bg-indigo-900/40 text-indigo' : 'bg-surface-2 text-text-muted'}`}>
                        {registry.length}
                    </span>
                </button>
                <button
                    onClick={() => setTab('extensions')}
                    className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === 'extensions'
                        ? 'border-indigo text-indigo'
                        : 'border-transparent text-text-muted hover:text-text-secondary'
                        }`}
                >
                    <Puzzle className="h-3.5 w-3.5" />
                    Extensions
                    {plugins.length > 0 && (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${tab === 'extensions' ? 'bg-indigo-900/40 text-indigo' : 'bg-surface-2 text-text-muted'}`}>
                            {plugins.length}
                        </span>
                    )}
                </button>
            </div>

            {/* Tab content */}
            {tab === 'integrations' && (
                <IntegrationsTab
                    registry={registry}
                    installed={installed}
                    workspaceId={workspaceId}
                />
            )}
            {tab === 'extensions' && (
                <ExtensionsTab
                    plugins={plugins}
                    workspaceId={workspaceId}
                />
            )}
        </div>
    )
}
