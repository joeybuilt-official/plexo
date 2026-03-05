'use client'

import { useState, useEffect, useCallback } from 'react'
import {
    Wrench,
    WrenchIcon,
    RefreshCw,
    AlertCircle,
    Info,
    ToggleLeft,
    ToggleRight,
    ChevronDown,
    ChevronRight,
    CheckCircle2,
    Circle,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

interface KapselManifest {
    name: string
    version: string
    description?: string
    type: string
    tools?: Array<{ name: string; description?: string; parameters?: Record<string, unknown> }>
    permissions?: string[]
}

interface Plugin {
    id: string
    name: string
    version: string
    type: string
    kapselVersion: string
    enabled: boolean
    enabledTools: string[] | null
    installedAt: string
    kapselManifest: KapselManifest | null
}

// Tools from installed connections (non-plugin)
interface ConnectionTool {
    connectionId: string
    connectionName: string
    registryId: string
    tool: string
    enabled: boolean
}

interface InstalledConnection {
    id: string
    registryId: string
    name: string
    status: string
    enabledTools: string[] | null
    toolsProvided?: string[]
}

interface RegistryItem {
    id: string
    toolsProvided: string[]
}

function ToolRow({ tool, enabled, onToggle }: { tool: string; enabled: boolean; onToggle?: () => void }) {
    return (
        <div
            className={`flex items-center justify-between rounded-lg border px-3 py-2 transition-all ${enabled
                ? 'border-zinc-700/60 bg-zinc-900/50'
                : 'border-zinc-800/30 bg-zinc-900/10 opacity-50'
                }`}
        >
            <div className="flex items-center gap-2">
                <Wrench className="h-3.5 w-3.5 text-zinc-600 shrink-0" />
                <span className="text-xs font-mono text-zinc-300">{tool}</span>
            </div>
            {onToggle ? (
                <button onClick={onToggle} className="shrink-0">
                    {enabled
                        ? <ToggleRight className="h-5 w-5 text-indigo-400" />
                        : <ToggleLeft className="h-5 w-5 text-zinc-700" />
                    }
                </button>
            ) : (
                enabled
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
                    : <Circle className="h-3.5 w-3.5 text-zinc-700 shrink-0" />
            )}
        </div>
    )
}

function SourceSection({ label, tools, count, total }: { label: string; tools: React.ReactNode[]; count: number; total: number }) {
    const [expanded, setExpanded] = useState(true)
    return (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
            <button
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-zinc-900/60 transition-colors"
                onClick={() => setExpanded((e) => !e)}
            >
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-300">{label}</span>
                    <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                        {count}/{total} enabled
                    </span>
                </div>
                {expanded
                    ? <ChevronDown className="h-3.5 w-3.5 text-zinc-600" />
                    : <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />
                }
            </button>
            {expanded && (
                <div className="px-4 pb-3 flex flex-col gap-1">
                    {tools}
                </div>
            )}
        </div>
    )
}

export default function ToolsPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const [plugins, setPlugins] = useState<Plugin[]>([])
    const [connections, setConnections] = useState<InstalledConnection[]>([])
    const [registry, setRegistry] = useState<RegistryItem[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [savingConn, setSavingConn] = useState<string | null>(null)

    const lf = useListFilter([], 'name_asc')
    const { search, clearAll } = lf

    const fetchAll = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        setError(null)
        try {
            const [plugRes, connRes, regRes] = await Promise.all([
                fetch(`${API_BASE}/api/v1/plugins?workspaceId=${WS_ID}`),
                fetch(`${API_BASE}/api/v1/connections/installed?workspaceId=${WS_ID}`),
                fetch(`${API_BASE}/api/v1/connections/registry`),
            ])
            if (plugRes.ok) {
                const d = await plugRes.json() as { items?: Plugin[] } | Plugin[]
                const items = Array.isArray(d) ? d : (d.items ?? [])
                setPlugins(items)
            }
            if (connRes.ok) {
                const d = await connRes.json() as { items: InstalledConnection[] }
                setConnections(d.items)
            }
            if (regRes.ok) {
                const d = await regRes.json() as { items: RegistryItem[] }
                setRegistry(d.items)
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load tools')
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchAll() }, [fetchAll])

    async function toggleConnectionTool(conn: InstalledConnection, tool: string, allTools: string[]) {
        setSavingConn(conn.id)
        const current = conn.enabledTools ?? [...allTools]
        const next = current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool]
        const payload = next.length === allTools.length ? null : next
        try {
            await fetch(`${API_BASE}/api/v1/connections/installed/${conn.id}/tools`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, enabledTools: payload }),
            })
            setConnections((prev) => prev.map((c) => c.id === conn.id ? { ...c, enabledTools: payload } : c))
        } finally {
            setSavingConn(null)
        }
    }

    // Aggregate tools from plugin extensions
    const rawPluginSections = plugins
        .filter((p) => p.enabled && (p.kapselManifest?.tools ?? []).length > 0)
        .map((p) => {
            const tools = p.kapselManifest!.tools!
            let filteredTools = tools

            if (search.trim()) {
                const q = search.toLowerCase()
                filteredTools = tools.filter(t => t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q))
            }

            return {
                key: p.id,
                label: `${p.name} (plugin)`,
                enabledCount: tools.length, // total enabled in DB, independent of filter for accurate source stat
                total: tools.length,
                filteredCount: filteredTools.length,
                nodes: filteredTools.map((t) => (
                    <ToolRow key={t.name} tool={t.name} enabled={true} />
                )),
            }
        })

    // Tools from installed connections
    const rawConnSections = connections.map((conn) => {
        const reg = registry.find((r) => r.id === conn.registryId)
        const allTools = reg?.toolsProvided ?? conn.toolsProvided ?? []
        const enabledTools = conn.enabledTools ?? allTools
        const isSaving = savingConn === conn.id

        let filteredTools = allTools

        if (search.trim()) {
            const q = search.toLowerCase()
            filteredTools = allTools.filter((t) => t.toLowerCase().includes(q))
        }

        return {
            key: conn.id,
            label: conn.name,
            enabledCount: enabledTools.length,
            total: allTools.length,
            filteredCount: filteredTools.length,
            nodes: filteredTools.map((t) => (
                <div key={t} className={isSaving ? 'opacity-50 pointer-events-none' : ''}>
                    <ToolRow
                        tool={t}
                        enabled={enabledTools.includes(t)}
                        onToggle={() => void toggleConnectionTool(conn, t, allTools)}
                    />
                </div>
            )),
        }
    })

    const connSections = rawConnSections.filter((s) => s.total > 0 && s.filteredCount > 0)
    const pluginSections = rawPluginSections.filter((s) => s.total > 0 && s.filteredCount > 0)

    const allSections = [...connSections, ...pluginSections].sort((a, b) => {
        if (lf.sort === 'name_desc') return b.label.localeCompare(a.label)
        if (lf.sort === 'most_tools') return b.enabledCount - a.enabledCount
        if (lf.sort === 'least_tools') return a.enabledCount - b.enabledCount
        return a.label.localeCompare(b.label)
    })
    const allSectionsUnfiltered = [...rawConnSections, ...rawPluginSections].filter(s => s.total > 0)

    const totalEnabled = allSectionsUnfiltered.reduce((n, s) => n + s.enabledCount, 0)
    const totalTools = allSectionsUnfiltered.reduce((n, s) => n + s.total, 0)

    return (
        <div className="flex flex-col gap-6 max-w-4xl">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-xl font-bold tracking-tight text-zinc-50">Tools</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        Agent-accessible tools from integrations and plugin extensions
                    </p>
                </div>
                <button
                    onClick={() => void fetchAll()}
                    disabled={loading}
                    title="Refresh"
                    className="flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors disabled:opacity-40"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">Refresh</span>
                </button>
            </div>

            {/* Info banner */}
            <div className="rounded-xl border border-blue-800/30 bg-blue-950/20 px-4 py-3 flex items-start gap-3">
                <Info className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
                <p className="text-xs text-blue-400/80">
                    Tools are functions the agent can call during task execution. They come from connected services (GitHub, Slack, etc.)
                    and Kapsel plugin extensions. Toggle individual tools to control what the agent can access.
                </p>
            </div>

            {error && (
                <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 flex items-center gap-2 text-xs text-red-400">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                </div>
            )}

            <ListToolbar
                hook={lf}
                placeholder="Search tools..."
                dimensions={[]}
                sortOptions={[
                    { label: 'Source: A → Z', value: 'name_asc' },
                    { label: 'Source: Z → A', value: 'name_desc' },
                    { label: 'Most enabled tools', value: 'most_tools' },
                    { label: 'Least enabled tools', value: 'least_tools' },
                ]}
            />

            {!loading && totalTools > 0 && (
                <div className="flex items-center gap-4 text-xs text-zinc-500">
                    <span><span className="text-zinc-300 font-medium">{totalEnabled}</span> / {totalTools} tools enabled</span>
                    <span><span className="text-zinc-300 font-medium">{allSectionsUnfiltered.length}</span> sources</span>
                </div>
            )}

            {loading ? (
                <div className="flex items-center justify-center py-16">
                    <RefreshCw className="h-5 w-5 text-zinc-600 animate-spin" />
                </div>
            ) : allSectionsUnfiltered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <WrenchIcon className="h-10 w-10 text-zinc-700" />
                    <div className="text-center">
                        <p className="text-sm font-medium text-zinc-500">No tools available</p>
                        <p className="text-xs text-zinc-600 mt-1">
                            Connect services in{' '}
                            <a href="/settings/connections" className="text-indigo-400 hover:underline">Integrations</a>{' '}
                            or install Kapsel plugins from the{' '}
                            <a href="/marketplace" className="text-indigo-400 hover:underline">Marketplace</a>.
                        </p>
                    </div>
                </div>
            ) : allSections.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-12 text-center">
                    <p className="text-sm text-zinc-500">No results match your filters.</p>
                    <button onClick={clearAll} className="mt-3 flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors mx-auto">
                        Clear search
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {allSections.map((s) => (
                        <SourceSection
                            key={s.key}
                            label={s.label}
                            tools={s.nodes}
                            count={s.enabledCount}
                            total={s.total}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
