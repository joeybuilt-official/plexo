'use client'

import { useState, useTransition } from 'react'

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
    doc_url: string | null
}

interface InstalledItem {
    id: string
    registryId: string
    name: string
    status: 'active' | 'error' | 'expired' | 'disconnected'
}

const CATEGORY_LABELS: Record<string, string> = {
    code: 'Code',
    communication: 'Communication',
    ai: 'AI',
    'project-management': 'Project Management',
    knowledge: 'Knowledge',
    ops: 'Ops',
    observability: 'Observability',
}

const STATUS_DOT: Record<string, string> = {
    active: 'bg-emerald-400',
    error: 'bg-red-400',
    expired: 'bg-amber-400',
    disconnected: 'bg-zinc-500',
}

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

    const hasSetupFields = (item.setup_fields ?? []).length > 0

    async function handleInstall() {
        startTransition(async () => {
            await onInstall(item, creds)
            setOpen(false)
            setCreds({})
        })
    }

    async function handleUninstall() {
        if (!installed) return
        startTransition(async () => {
            await onUninstall(installed.id)
        })
    }

    return (
        <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 gap-4 transition-colors hover:border-zinc-700">
            {/* Header */}
            <div className="flex items-start gap-3">
                {item.logo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.logo_url} alt={item.name} className="h-8 w-8 rounded object-contain bg-white p-0.5" />
                ) : (
                    <div className="h-8 w-8 rounded bg-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-300">
                        {item.name[0]}
                    </div>
                )}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-zinc-100 truncate">{item.name}</h3>
                        {item.is_core && (
                            <span className="shrink-0 rounded-full bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-indigo-400">
                                Core
                            </span>
                        )}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500 line-clamp-2">{item.description}</p>
                </div>
            </div>

            {/* Tools */}
            <div className="flex flex-wrap gap-1">
                {(item.tools_provided ?? []).slice(0, 4).map((t) => (
                    <span key={t} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
                        {t}
                    </span>
                ))}
                {(item.tools_provided ?? []).length > 4 && (
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500">
                        +{(item.tools_provided ?? []).length - 4}
                    </span>
                )}
            </div>

            {/* Action */}
            {installed ? (
                <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[installed.status] ?? 'bg-zinc-500'}`} />
                        {installed.status}
                    </span>
                    <button
                        onClick={handleUninstall}
                        disabled={pending}
                        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-red-800 hover:text-red-400 transition-colors disabled:opacity-40"
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
                                    <label className="text-[10px] text-zinc-500 uppercase tracking-wide">{field.label}</label>
                                    <input
                                        type={field.type === 'password' ? 'password' : 'text'}
                                        value={creds[field.key] ?? ''}
                                        onChange={(e) => setCreds((p) => ({ ...p, [field.key]: e.target.value }))}
                                        className="mt-0.5 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                                        placeholder={`Enter ${field.label.toLowerCase()}`}
                                    />
                                </div>
                            ))}
                        </div>
                    )}
                    <button
                        onClick={hasSetupFields ? (open ? handleInstall : () => setOpen(true)) : handleInstall}
                        disabled={pending}
                        className="w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-40"
                    >
                        {pending ? 'Installing…' : hasSetupFields && !open ? 'Configure' : 'Install'}
                    </button>
                </div>
            )}
        </div>
    )
}

export default function MarketplaceClient({
    registry,
    installed: initialInstalled,
    workspaceId,
}: {
    registry: RegistryItem[]
    installed: InstalledItem[]
    workspaceId: string
}) {
    const [installed, setInstalled] = useState(initialInstalled)
    const [category, setCategory] = useState<string | null>(null)
    const [search, setSearch] = useState('')

    const categories = [...new Set(registry.map((r) => r.category))]

    const filtered = registry.filter((item) => {
        const matchesCat = !category || item.category === category
        const matchesSearch = !search || item.name.toLowerCase().includes(search.toLowerCase())
        return matchesCat && matchesSearch
    })

    const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

    async function handleInstall(item: RegistryItem, creds: Record<string, string>) {
        const res = await fetch(`${apiBase}/api/connections/install`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, registryId: item.id, credentials: creds }),
        })
        if (res.ok) {
            const data = await res.json() as { id: string }
            setInstalled((prev) => [...prev, { id: data.id, registryId: item.id, name: item.name, status: 'active' }])
        }
    }

    async function handleUninstall(id: string) {
        await fetch(`${apiBase}/api/connections/installed/${id}?workspaceId=${workspaceId}`, {
            method: 'DELETE',
        })
        setInstalled((prev) => prev.filter((i) => i.id !== id))
    }

    return (
        <div className="flex flex-col gap-6">
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Marketplace</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Connect tools and services to extend what the agent can do.
                </p>
            </div>

            {/* Search + filter */}
            <div className="flex flex-wrap gap-2">
                <input
                    type="text"
                    placeholder="Search integrations…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="flex-1 min-w-48 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                />
                <div className="flex flex-wrap gap-1.5">
                    <button
                        onClick={() => setCategory(null)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${!category ? 'bg-indigo-600 text-white' : 'border border-zinc-700 text-zinc-400 hover:border-zinc-600'}`}
                    >
                        All
                    </button>
                    {categories.map((cat) => (
                        <button
                            key={cat}
                            onClick={() => setCategory(cat === category ? null : cat)}
                            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${category === cat ? 'bg-indigo-600 text-white' : 'border border-zinc-700 text-zinc-400 hover:border-zinc-600'}`}
                        >
                            {CATEGORY_LABELS[cat] ?? cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* Summary */}
            <div className="flex items-center gap-4 text-xs text-zinc-500">
                <span>{installed.length} installed</span>
                <span>{filtered.length} available</span>
            </div>

            {/* Grid */}
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
