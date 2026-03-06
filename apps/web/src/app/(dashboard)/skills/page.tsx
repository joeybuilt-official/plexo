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
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface KapselManifest {
    name: string
    version: string
    description?: string
    type: string
    kapsel: string
    skills?: Array<{ name: string; description?: string; triggers?: string[] }>
    tools?: Array<{ name: string; description?: string }>
    permissions?: string[]
    minHostLevel?: string
}

interface Plugin {
    id: string
    name: string
    version: string
    type: string
    kapselVersion: string
    enabled: boolean
    installedAt: string
    kapselManifest: KapselManifest | null
    settings: Record<string, unknown>
}

function SkillCard({ plugin, onToggle }: { plugin: Plugin; onToggle: (id: string, enabled: boolean) => Promise<void> }) {
    const [expanded, setExpanded] = useState(false)
    const [toggling, setToggling] = useState(false)
    const manifest = plugin.kapselManifest
    const skills = manifest?.skills ?? []
    const isSkillType = plugin.type === 'skill' || skills.length > 0

    if (!isSkillType) return null

    async function handleToggle() {
        setToggling(true)
        try {
            await onToggle(plugin.id, !plugin.enabled)
        } finally {
            setToggling(false)
        }
    }

    return (
        <div className={`rounded-xl border transition-all ${plugin.enabled
            ? 'border-zinc-700/60 bg-zinc-900/60'
            : 'border-zinc-800/40 bg-zinc-900/20 opacity-70'
            }`}>
            <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                onClick={() => setExpanded((e) => !e)}
            >
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${plugin.enabled ? 'bg-indigo-600/20' : 'bg-zinc-800'}`}>
                    <Zap className={`h-4 w-4 ${plugin.enabled ? 'text-indigo-400' : 'text-zinc-600'}`} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-zinc-200 truncate">{plugin.name}</span>
                        <span className="text-[10px] font-mono text-zinc-600 shrink-0">v{plugin.version}</span>
                        <span className="text-[10px] text-zinc-600 shrink-0">kapsel@{plugin.kapselVersion}</span>
                    </div>
                    {manifest?.description && (
                        <p className="text-xs text-zinc-500 truncate">{manifest.description}</p>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={(e) => { e.stopPropagation(); void handleToggle() }}
                        disabled={toggling}
                        className="flex items-center gap-1 rounded-lg border border-zinc-700 px-2.5 py-1 text-xs transition-colors hover:border-zinc-600 disabled:opacity-40"
                    >
                        {toggling ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                        ) : plugin.enabled ? (
                            <><ToggleRight className="h-4 w-4 text-indigo-400" /><span className="text-indigo-400">Enabled</span></>
                        ) : (
                            <><ToggleLeft className="h-4 w-4 text-zinc-600" /><span className="text-zinc-500">Disabled</span></>
                        )}
                    </button>
                    {expanded
                        ? <ChevronDown className="h-3.5 w-3.5 text-zinc-600" />
                        : <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />
                    }
                </div>
            </div>

            {expanded && (
                <div className="border-t border-zinc-800 px-4 py-3 flex flex-col gap-3">
                    {skills.length > 0 && (
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-2">Skills provided</p>
                            <div className="flex flex-col gap-1.5">
                                {skills.map((s, i) => (
                                    <div key={i} className="rounded-lg bg-zinc-800/60 px-3 py-2">
                                        <div className="flex items-center gap-2">
                                            <Zap className="h-3 w-3 text-indigo-400 shrink-0" />
                                            <span className="text-xs font-mono font-medium text-zinc-300">{s.name}</span>
                                        </div>
                                        {s.description && (
                                            <p className="mt-0.5 text-[11px] text-zinc-500 pl-5">{s.description}</p>
                                        )}
                                        {s.triggers && s.triggers.length > 0 && (
                                            <div className="mt-1 pl-5 flex flex-wrap gap-1">
                                                {s.triggers.map((t) => (
                                                    <span key={t} className="rounded bg-zinc-700 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">{t}</span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    {(manifest?.permissions ?? []).length > 0 && (
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-600 mb-1.5">Permissions</p>
                            <div className="flex flex-wrap gap-1">
                                {manifest!.permissions!.map((p) => (
                                    <span key={p} className="rounded border border-amber-800/40 bg-amber-950/20 px-2 py-0.5 text-[10px] font-mono text-amber-400">{p}</span>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="flex items-center gap-4 text-[11px] text-zinc-600">
                        <span>Installed {new Date(plugin.installedAt).toLocaleDateString()}</span>
                        {manifest?.minHostLevel && <span>Requires host level: <span className="text-zinc-400">{manifest.minHostLevel}</span></span>}
                    </div>
                </div>
            )}
        </div>
    )
}

export default function SkillsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [plugins, setPlugins] = useState<Plugin[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const lf = useListFilter([], 'name_asc')
    const { search, clearAll } = lf

    const fetchPlugins = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/plugins?workspaceId=${WS_ID}`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json() as { items: Plugin[] }
            setPlugins(data.items)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load skills')
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchPlugins() }, [fetchPlugins])

    async function handleToggle(id: string, enabled: boolean) {
        const res = await fetch(`${API_BASE}/api/v1/plugins/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled }),
        })
        if (res.ok) {
            setPlugins((prev) => prev.map((p) => p.id === id ? { ...p, enabled } : p))
        }
    }

    const skillPlugins = plugins.filter(
        (p) => p.type === 'skill' || (p.kapselManifest?.skills ?? []).length > 0
    )

    const filteredPlugins = skillPlugins.filter((p) => {
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return (
            p.name.toLowerCase().includes(q) ||
            p.kapselManifest?.description?.toLowerCase().includes(q) ||
            (p.kapselManifest?.skills ?? []).some(s => s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q))
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
                    <h1 className="text-xl font-bold tracking-tight text-zinc-50">Skills</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        Kapsel skill extensions — autonomous capabilities the agent can invoke
                    </p>
                </div>
                <button
                    onClick={() => void fetchPlugins()}
                    disabled={loading}
                    title="Refresh"
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">Refresh</span>
                </button>
            </div>

            {/* Info banner */}
            <div className="rounded-xl border border-indigo-800/30 bg-indigo-950/20 px-4 py-3 flex items-start gap-3">
                <Info className="h-4 w-4 text-indigo-400 shrink-0 mt-0.5" />
                <div>
                    <p className="text-xs font-medium text-indigo-300 mb-0.5">Kapsel Skill Extensions</p>
                    <p className="text-xs text-indigo-400/70">
                        Skills are Kapsel-packaged extensions that grant the agent new autonomous capabilities. Install via the Marketplace, then enable here.
                        Each skill declares triggers, permissions, and tools via its <code className="text-indigo-300">kapsel.json</code> manifest.
                    </p>
                </div>
            </div>

            {error && (
                <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                </div>
            )}

            <ListToolbar
                hook={lf}
                placeholder="Search skills..."
                dimensions={[]}
                sortOptions={[
                    { label: 'Name: A → Z', value: 'name_asc' },
                    { label: 'Name: Z → A', value: 'name_desc' },
                    { label: 'Enabled first', value: 'enabled_first' },
                    { label: 'Disabled first', value: 'disabled_first' },
                ]}
            />

            {loading ? (
                <div className="flex items-center justify-center py-16">
                    <RefreshCw className="h-5 w-5 text-zinc-600 animate-spin" />
                </div>
            ) : skillPlugins.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <ZapOff className="h-10 w-10 text-zinc-700" />
                    <div className="text-center">
                        <p className="text-sm font-medium text-zinc-500">No skill extensions installed</p>
                        <p className="text-xs text-zinc-600 mt-1">
                            Install Kapsel skill packages from the <a href="/marketplace" className="text-indigo-400 hover:underline">Marketplace</a> to extend the agent.
                        </p>
                    </div>
                </div>
            ) : filteredPlugins.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-12 text-center">
                    <p className="text-sm text-zinc-500">No results match your filters.</p>
                    <button onClick={clearAll} className="mt-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors mx-auto">
                        Clear search
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-zinc-600">{skillPlugins.filter((p) => p.enabled).length} / {skillPlugins.length} enabled</p>
                    </div>
                    {filteredPlugins.map((p) => (
                        <SkillCard key={p.id} plugin={p} onToggle={handleToggle} />
                    ))}
                </div>
            )}

            {/* All-plugins fallback — show non-skill types too if any */}
            {!loading && plugins.length > 0 && skillPlugins.length === 0 && plugins.some((p) => p.type !== 'skill') && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3">
                    <div className="flex items-center gap-2 mb-2">
                        <Package className="h-4 w-4 text-zinc-600" />
                        <p className="text-xs font-medium text-zinc-400">Other installed extensions</p>
                    </div>
                    <p className="text-xs text-zinc-600">
                        {plugins.length} extension(s) installed but none have type=&quot;skill&quot;. Check the Marketplace or plugin type.
                    </p>
                </div>
            )}
        </div>
    )
}
