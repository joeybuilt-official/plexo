// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useFocusTrap } from '@web/hooks/use-focus-trap'
import { useSearchParams } from 'next/navigation'
import dynamicImport from 'next/dynamic'
import {
    Link2Off, Circle, Plus, Server, Zap, ChevronDown, Globe2, MessageSquare, Bot, X,
} from 'lucide-react'
import { useWorkspaceId } from '@web/context/workspace'
import { useListFilter } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { ConfigListLayout } from '@web/components/config-list-layout'

import type {
    RegistryItem, InstalledConnection, ChannelSummary, LiveTool, LiveToolsResponse,
    DetailTab,
} from './_components/types'
import { API_BASE, CHANNEL_TO_REGISTRY } from './_components/types'
import { AuthIcon, StatusDot } from './_components/badges'
import ConnectionDetail from './_components/connection-detail'

// Custom integration modal is rarely opened — lazy-load, no SSR.
const CustomIntegrationModal = dynamicImport(
    () => import('./_components/custom-integration-modal'),
    { ssr: false, loading: () => null },
)

const FILTER_KEYS = ['category', 'status'] as const
const ALL_CATEGORIES = ['All', 'Code', 'Communication', 'Productivity', 'Finance', 'Analytics', 'Storage', 'MCP', 'Custom API']

export default function IntegrationsPage() {
    return (
        <Suspense>
            <IntegrationsContent />
        </Suspense>
    )
}

function IntegrationsContent() {
    const WS_ID = useWorkspaceId()
    const [registry, setRegistry] = useState<RegistryItem[]>([])
    const [installed, setInstalled] = useState<InstalledConnection[]>([])
    const [selected, setSelected] = useState<RegistryItem | null>(null)
    const [loading, setLoading] = useState(true)
    const [channels, setChannels] = useState<ChannelSummary[]>([])
    const initialSelectionMade = useRef(false)

    const lf = useListFilter(FILTER_KEYS, 'default')
    const { search, filterValues, setFilter } = lf

    // UI-audit Phase 8c — ?filter=warnings deep link from the sidebar red-
    // dot indicator. When present on first mount, pre-filter the list to
    // only show connections that are installed-but-not-healthy (the set
    // the warning badge represents). Uses the existing `status` filter
    // dimension via useListFilter's setFilter hook, so toggling it off is
    // the normal clear-filter flow from the toolbar.
    const searchParams = useSearchParams()
    const warningsParam = searchParams?.get('filter')
    const appliedWarningsFilter = useRef(false)
    useEffect(() => {
        if (appliedWarningsFilter.current) return
        if (warningsParam === 'warnings') {
            setFilter('status', 'warning')
            appliedWarningsFilter.current = true
        }
    }, [warningsParam, setFilter])
    const [installing, setInstalling] = useState(false)
    const [disconnecting, setDisconnecting] = useState(false)
    const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
    const [activeTab, setActiveTab] = useState<DetailTab>('overview')
    const [savingTools, setSavingTools] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [liveTools, setLiveTools] = useState<LiveTool[] | null>(null)
    const [loadingLiveTools, setLoadingLiveTools] = useState(false)

    const [showAddMenu, setShowAddMenu] = useState(false)
    const [addCustomType, setAddCustomType] = useState<'mcp' | 'custom_api' | 'a2a' | null>(null)
    const a2aTrapRef = useFocusTrap<HTMLDivElement>(addCustomType === 'a2a')
    const [customName, setCustomName] = useState('')
    const [customUrl, setCustomUrl] = useState('')
    const [customDescription, setCustomDescription] = useState('')
    const [customAuthType, setCustomAuthType] = useState<'none' | 'api_key' | 'bearer' | 'basic'>('none')
    const [customAuthValue, setCustomAuthValue] = useState('')
    const [customSaving, setCustomSaving] = useState(false)
    const [testing, setTesting] = useState<string | null>(null)
    const [testResult, setTestResult] = useState<Record<string, { ok: boolean; status: number; statusText: string } | null>>({})

    function resetCustomForm() {
        setAddCustomType(null)
        setCustomName('')
        setCustomUrl('')
        setCustomDescription('')
        setCustomAuthType('none')
        setCustomAuthValue('')
    }

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
                if (!initialSelectionMade.current && d.items.length > 0) {
                    const highlightId = typeof window !== 'undefined'
                        ? new URLSearchParams(window.location.search).get('highlight')
                        : null
                    const target = highlightId
                        ? (d.items.find((i) => i.id === highlightId) ?? d.items[0])
                        : d.items[0]
                    setSelected(target)
                    initialSelectionMade.current = true
                }
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
            setError('Failed to load integrations')
        } finally {
            setLoading(false)
        }
    }, [])  // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => { void fetchData() }, [WS_ID])  // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!showAddMenu) return
        const handler = () => setShowAddMenu(false)
        const t = setTimeout(() => document.addEventListener('click', handler), 0)
        return () => { clearTimeout(t); document.removeEventListener('click', handler) }
    }, [showAddMenu])

    const connectedItem = selected
        ? installed.find((i) => i.registryId === selected.id) ?? null
        : null

    const isConnected = connectedItem !== null

    const linkedChannels = selected
        ? channels.filter((ch) => CHANNEL_TO_REGISTRY[ch.type] === selected.id)
        : []

    const enabledTools: string[] | null = connectedItem?.enabledTools ?? null
    const allTools = liveTools?.map((t) => t.name) ?? selected?.toolsProvided ?? []
    const hasLiveTools = liveTools !== null

    useEffect(() => {
        if (!connectedItem || !WS_ID) {
            setLiveTools(null)
            return
        }
        let cancelled = false
        setLoadingLiveTools(true)
        void (async () => {
            try {
                const res = await fetch(
                    `${API_BASE}/api/v1/connections/installed/${connectedItem.id}/tools?workspaceId=${WS_ID}`,
                )
                if (!res.ok) {
                    if (!cancelled) setLiveTools([])
                    return
                }
                const data = (await res.json()) as LiveToolsResponse
                if (!cancelled) setLiveTools(data.tools)
            } catch {
                if (!cancelled) setLiveTools([])
            } finally {
                if (!cancelled) setLoadingLiveTools(false)
            }
        })()
        return () => { cancelled = true }
    }, [connectedItem?.id, connectedItem?.enabledTools, WS_ID])  // eslint-disable-line react-hooks/exhaustive-deps

    function isToolEnabled(toolName: string, shortName?: string): boolean {
        if (enabledTools === null) return true
        if (enabledTools.includes(toolName)) return true
        if (shortName && enabledTools.includes(shortName)) return true
        return false
    }

    async function saveEnabledTools(payload: string[] | null) {
        if (!connectedItem) return
        setSavingTools(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/connections/installed/${connectedItem.id}/tools`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, enabledTools: payload }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
                setError(body?.error?.message ?? 'Failed to update tools')
                return
            }
            setInstalled((prev) => prev.map((i) =>
                i.id === connectedItem.id ? { ...i, enabledTools: payload } : i
            ))
            setLiveTools((prev) => prev
                ? prev.map((t) => ({
                    ...t,
                    enabled: payload === null
                        || payload.includes(t.shortName)
                        || payload.includes(t.name),
                }))
                : prev,
            )
        } finally {
            setSavingTools(false)
        }
    }

    async function toggleTool(toolName: string, shortName: string) {
        if (!connectedItem || !hasLiveTools) return
        const currentShort: string[] = enabledTools === null
            ? liveTools!.map((t) => t.shortName)
            : liveTools!
                .filter((t) => isToolEnabled(t.name, t.shortName))
                .map((t) => t.shortName)
        const next = currentShort.includes(shortName)
            ? currentShort.filter((t) => t !== shortName)
            : [...currentShort, shortName]
        const payload: string[] | null = next.length === (liveTools?.length ?? 0) ? null : next
        void toolName
        await saveEnabledTools(payload)
    }

    async function enableReadOnlyMode() {
        if (!connectedItem) return
        setSavingTools(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/connections/installed/${connectedItem.id}/tools`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, mode: 'read-only' }),
            })
            if (!res.ok) {
                setError('Failed to enable read-only mode')
                return
            }
            const data = await res.json() as { enabledTools: string[] | null }
            setInstalled((prev) => prev.map((i) =>
                i.id === connectedItem.id ? { ...i, enabledTools: data.enabledTools } : i
            ))
            setLiveTools((prev) => prev
                ? prev.map((t) => ({ ...t, enabled: !t.isWrite }))
                : prev,
            )
        } finally {
            setSavingTools(false)
        }
    }

    async function enableAllTools() {
        await saveEnabledTools(null)
    }

    async function handleInstall() {
        if (!selected || !WS_ID) return

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
                    setError(`${selected.name} OAuth not configured: set ${envVar} in the API environment. ${msg}`)
                } else {
                    setError(`OAuth failed: ${String(ev.data.error ?? 'unknown')}`)
                }
            }
            window.addEventListener('message', handleMessage)
            const pollClosed = setInterval(() => {
                if (popup.closed) {
                    clearInterval(pollClosed)
                    window.removeEventListener('message', handleMessage)
                    setInstalling(false)
                }
            }, 500)
            return
        }

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

    async function handleCustomSave() {
        if (!customName.trim() || !customUrl.trim() || !WS_ID || !addCustomType || addCustomType === 'a2a') return
        setCustomSaving(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/connections/custom`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId: WS_ID,
                    type: addCustomType,
                    name: customName.trim(),
                    url: customUrl.trim(),
                    description: customDescription.trim() || undefined,
                    authType: customAuthType,
                    authValue: customAuthValue || undefined,
                }),
            })
            if (res.ok) {
                resetCustomForm()
                await fetchData()
            } else {
                const d = await res.json() as { error?: { message?: string } }
                setError(d.error?.message ?? 'Failed to create custom integration')
            }
        } finally {
            setCustomSaving(false)
        }
    }

    async function handleA2aSave() {
        if (!customUrl.trim() || !WS_ID) return
        setCustomSaving(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/a2a/agents/external`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId: WS_ID,
                    url: customUrl.trim(),
                    bearerToken: customAuthValue || undefined,
                }),
            })
            if (res.ok) {
                resetCustomForm()
                await fetchData()
            } else {
                const d = await res.json() as { error?: string }
                setError(d.error ?? 'Failed to add A2A agent')
            }
        } finally {
            setCustomSaving(false)
        }
    }

    async function handleTestConnection(connectionId: string) {
        if (!WS_ID) return
        setTesting(connectionId)
        try {
            const res = await fetch(`${API_BASE}/api/v1/connections/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connectionId, workspaceId: WS_ID }),
            })
            const data = await res.json() as { ok: boolean; status: number; statusText: string }
            setTestResult(prev => ({ ...prev, [connectionId]: data }))
        } catch {
            setTestResult(prev => ({ ...prev, [connectionId]: { ok: false, status: 0, statusText: 'Request failed' } }))
        } finally {
            setTesting(null)
        }
    }

    const filtered = registry.filter((r) => {
        const matchCat = !filterValues.category || filterValues.category === 'all' || r.category.toLowerCase() === filterValues.category.toLowerCase()
        const matchStatus = (() => {
            if (!filterValues.status) return true
            const inst = installed.find((i) => i.registryId === r.id)
            const isInstalled = !!inst
            if (filterValues.status === 'connected') return isInstalled
            if (filterValues.status === 'unconnected') return !isInstalled
            // UI-audit Phase 8c — `warning` filter value matches the same
            // condition as the sidebar's red-dot badge (installed row with
            // underlying status === 'disconnected'). Deep link entry point
            // is `/app/connections?filter=warnings` from the badge.
            if (filterValues.status === 'warning') return isInstalled && (inst as { status?: string } | undefined)?.status === 'disconnected'
            return true
        })()
        const matchSearch = !search ||
            r.name.toLowerCase().includes(search.toLowerCase()) ||
            r.description.toLowerCase().includes(search.toLowerCase()) ||
            r.category.toLowerCase().includes(search.toLowerCase())
        return matchCat && matchStatus && matchSearch
    })

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
                { value: 'warning', label: 'Warning', dimmed: !installed.some((i) => (i as { status?: string }).status === 'disconnected') },
            ]
        }
    ]

    const headerActions = (
        <div className="relative">
            <button
                onClick={() => setShowAddMenu(v => !v)}
                className="flex items-center gap-1.5 rounded-lg bg-azure px-3 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors"
            >
                <Plus className="h-4 w-4" />
                Add
                <ChevronDown className="h-3 w-3" />
            </button>
            {showAddMenu && (
                <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border border-border bg-surface-0 shadow-lg py-1">
                    <button
                        onClick={() => { setShowAddMenu(false); setAddCustomType('mcp') }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-text-secondary hover:bg-surface-2 transition-colors text-left"
                    >
                        <Server className="h-4 w-4 text-rose-400" />
                        <div>
                            <div className="font-medium text-text-primary">Custom Connector</div>
                            <div className="text-[11px] text-text-muted">Bridge an external MCP server</div>
                        </div>
                    </button>
                    <button
                        onClick={() => { setShowAddMenu(false); setAddCustomType('custom_api') }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-text-secondary hover:bg-surface-2 transition-colors text-left"
                    >
                        <Zap className="h-4 w-4 text-emerald-400" />
                        <div>
                            <div className="font-medium text-text-primary">Custom API</div>
                            <div className="text-[11px] text-text-muted">REST API or webhook endpoint</div>
                        </div>
                    </button>
                    <button
                        onClick={() => { setShowAddMenu(false); setAddCustomType('a2a') }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-text-secondary hover:bg-surface-2 transition-colors text-left"
                    >
                        <Bot className="h-4 w-4 text-azure" />
                        <div>
                            <div className="font-medium text-text-primary">External A2A Agent</div>
                            <div className="text-[11px] text-text-muted">Connect any A2A-compatible agent</div>
                        </div>
                    </button>
                    <div className="border-t border-border my-1" />
                    <button
                        onClick={() => { setShowAddMenu(false) }}
                        className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm text-text-secondary hover:bg-surface-2 transition-colors text-left"
                    >
                        <Globe2 className="h-4 w-4 text-azure" />
                        <div>
                            <div className="font-medium text-text-primary">From Registry</div>
                            <div className="text-[11px] text-text-muted">Browse pre-built integrations below</div>
                        </div>
                    </button>
                </div>
            )}
        </div>
    )

    function renderListItem(r: RegistryItem) {
        const inst = installed.find((i) => i.registryId === r.id)
        const linkedChs = channels.filter((ch) => CHANNEL_TO_REGISTRY[ch.type] === r.id)
        const hasActiveChannel = linkedChs.some((ch) => ch.enabled)
        return (
            <div className="flex items-center justify-between gap-2 h-full">
                <div className="flex items-center gap-2.5">
                    {r.logoUrl ? (
                        <span className="relative h-6 w-6 shrink-0">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                                src={r.logoUrl}
                                alt={r.name}
                                className="h-6 w-6 rounded object-contain bg-white/5"
                                onError={(e) => {
                                    e.currentTarget.style.display = 'none';
                                    (e.currentTarget.nextElementSibling as HTMLElement | null)?.style.setProperty('display', 'flex')
                                }}
                            />
                            <span className="h-6 w-6 rounded bg-surface-2 items-center justify-center text-[11px] font-bold text-text-secondary hidden" style={{ display: 'none' }}>
                                {r.name.slice(0, 2).toUpperCase()}
                            </span>
                        </span>
                    ) : (
                        <div className="h-6 w-6 rounded bg-surface-2 flex items-center justify-center text-[11px] font-bold text-text-secondary">
                            {r.name.slice(0, 2).toUpperCase()}
                        </div>
                    )}
                    <span className="text-sm font-medium text-text-primary truncate max-w-[120px]">{r.name}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {r.stub && (
                        <span className="text-[9px] font-semibold uppercase tracking-wide text-text-muted bg-surface-2 rounded px-1 py-0.5 border border-border">
                            Soon
                        </span>
                    )}
                    {!r.stub && <AuthIcon type={r.authType} />}
                    {!r.stub && hasActiveChannel && (
                        <span title={`Channel: ${linkedChs.map(c => c.name).join(', ')}`}>
                            <MessageSquare className="h-3 w-3 text-teal-400" />
                        </span>
                    )}
                    {!r.stub && (inst ? <StatusDot status={inst.status} /> : <Circle className="h-3 w-3 text-text-muted" />)}
                </div>
            </div>
        )
    }

    const detail = selected ? (
        <ConnectionDetail
            selected={selected}
            connectedItem={connectedItem}
            isConnected={isConnected}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            installing={installing}
            disconnecting={disconnecting}
            WS_ID={WS_ID}
            testing={testing}
            testResult={testResult}
            onTest={handleTestConnection}
            fieldValues={fieldValues}
            setFieldValues={setFieldValues}
            liveTools={liveTools}
            loadingLiveTools={loadingLiveTools}
            hasLiveTools={hasLiveTools}
            allTools={allTools}
            enabledTools={enabledTools}
            savingTools={savingTools}
            linkedChannels={linkedChannels}
            onInstall={() => void handleInstall()}
            onDisconnect={() => void handleDisconnect()}
            onToggleTool={(n, s) => void toggleTool(n, s)}
            onReadOnly={() => void enableReadOnlyMode()}
            onEnableAll={() => void enableAllTools()}
        />
    ) : null

    const emptyDetail = (
        <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
                <Link2Off className="mx-auto h-8 w-8 text-text-muted mb-2" />
                <p className="text-sm text-text-muted">Select a service</p>
            </div>
        </div>
    )

    return (
        <>
            <ConfigListLayout
                title="Connections"
                subtitle={<>External service connections for your workspace. {installed.length} active.</>}
                headerActions={headerActions}
                filterHook={lf}
                searchPlaceholder="Search integrations…"
                filterDimensions={dimensions}
                sortOptions={[
                    { label: 'Priority (Connected first)', value: 'default' },
                    { label: 'Name (A-Z)', value: 'name_asc' },
                    { label: 'Name (Z-A)', value: 'name_desc' },
                ]}
                items={sorted}
                loading={loading}
                emptyMessage="No integrations match your search"
                getItemKey={(r) => r.id}
                isSelected={(r) => r.id === selected?.id}
                onSelect={(r) => { setSelected(r); setActiveTab('overview') }}
                renderListItem={(r) => renderListItem(r)}
                listWidthClass="md:w-[280px]"
                detail={detail}
                emptyDetail={emptyDetail}
                errorBanner={error ? (
                    <div className="rounded-lg border border-red-800/50 bg-red-dim px-3 py-2 text-xs text-red flex items-center justify-between">
                        {error}
                        <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-red-600 hover:text-red">✕</button>
                    </div>
                ) : null}
                footer={!WS_ID ? (
                    <p className="text-xs text-red">NEXT_PUBLIC_DEFAULT_WORKSPACE not set — integrations will not persist.</p>
                ) : null}
            />

            {addCustomType && addCustomType !== 'a2a' && (
                <CustomIntegrationModal
                    addCustomType={addCustomType}
                    customName={customName}
                    setCustomName={setCustomName}
                    customUrl={customUrl}
                    setCustomUrl={setCustomUrl}
                    customDescription={customDescription}
                    setCustomDescription={setCustomDescription}
                    customAuthType={customAuthType}
                    setCustomAuthType={setCustomAuthType}
                    customAuthValue={customAuthValue}
                    setCustomAuthValue={setCustomAuthValue}
                    customSaving={customSaving}
                    onClose={resetCustomForm}
                    onSave={() => void handleCustomSave()}
                />
            )}

            {addCustomType === 'a2a' && (
                <div
                    ref={a2aTrapRef}
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                    onClick={(e) => { if (e.target === e.currentTarget) resetCustomForm() }}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="a2a-modal-title"
                >
                    <div className="w-full max-w-lg rounded-xl border border-border bg-surface-0 shadow-2xl">
                        <div className="flex items-center justify-between border-b border-border px-5 py-4">
                            <div className="flex items-center gap-2">
                                <Bot className="h-4 w-4 text-azure" aria-hidden="true" />
                                <h2 id="a2a-modal-title" className="text-base font-semibold text-text-primary">
                                    Add External A2A Agent
                                </h2>
                            </div>
                            <button onClick={resetCustomForm} className="text-text-muted hover:text-text-secondary transition-colors p-1" aria-label="Close">
                                <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </div>
                        <div className="flex flex-col gap-4 px-5 py-5">
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-text-secondary">Agent URL</label>
                                <input
                                    type="url"
                                    value={customUrl}
                                    onChange={(e) => setCustomUrl(e.target.value)}
                                    placeholder="https://agent.example.com"
                                    autoFocus
                                    className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                                />
                                <p className="text-[11px] text-text-muted">Plexo will fetch <code className="font-mono">/.well-known/agent.json</code> to validate the agent card.</p>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-text-secondary">Bearer Token <span className="text-text-muted font-normal">(optional)</span></label>
                                <input
                                    type="password"
                                    value={customAuthValue}
                                    onChange={(e) => setCustomAuthValue(e.target.value)}
                                    placeholder="sk-••••••••"
                                    autoComplete="new-password"
                                    className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                                />
                            </div>
                            <div className="rounded-lg border border-azure/20 bg-azure/5 px-3 py-3">
                                <p className="text-[11px] text-azure/70 leading-relaxed">
                                    The agent will appear as a callable tool in the extension library. Plexo routes tasks to it via the A2A protocol.
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
                            <button
                                onClick={resetCustomForm}
                                className="rounded-lg border border-border px-4 min-h-[44px] text-sm font-medium text-text-secondary hover:bg-surface-2 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={() => void handleA2aSave()}
                                disabled={!customUrl.trim() || customSaving}
                                className="rounded-lg bg-azure px-4 min-h-[44px] text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50"
                            >
                                {customSaving ? 'Connecting...' : 'Connect Agent'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
