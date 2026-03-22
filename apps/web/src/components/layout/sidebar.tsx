// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { createClient } from '@web/lib/supabase/client'
import {
    LayoutDashboard,
    MessageSquare,
    MessagesSquare,
    CheckSquare,
    FolderOpen,
    Clock,
    Plug,
    Radio,
    Store,
    Brain,
    BrainCircuit,
    Cpu,
    Bot,
    Settings as SettingsIcon,
    Users,
    FileText,
    Terminal,
    ChevronDown,
    ChevronRight,
    ShieldAlert,
    ShieldCheck,
    ChevronsUpDown,
    Plus,
    Check,
    Zap,
    Wrench,
    LogOut,
    Mic,
    RefreshCw,
    Sparkles as _Sparkles, // kept for potential future use
    Home,
    MessageCircle,
    PanelLeftClose,
    PanelLeftOpen,
    Palette
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

// useLayoutEffect on client, noop on server (avoids SSR warning)
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

interface SessionUser {
    name?: string | null
    email?: string | null
}

interface NavItem {
    label: string
    href: string
    icon: React.ElementType
    exact?: boolean  // if true, only active on exact pathname match (avoids prefix collisions)
}

interface NavGroup {
    label: string
    collapsible: boolean
    defaultOpen: boolean
    items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
    {
        label: 'Work',
        collapsible: true,
        defaultOpen: true,
        items: [
            { label: 'Overview', href: '/overview', icon: LayoutDashboard },
            { label: 'Chat', href: '/chat', icon: MessageCircle },
            { label: 'Tasks', href: '/tasks', icon: CheckSquare },
            { label: 'Projects', href: '/projects', icon: FolderOpen },
            { label: 'Approvals', href: '/approvals', icon: ShieldAlert },
        ],
    },
    {
        label: 'Platform',
        collapsible: true,
        defaultOpen: true,
        items: [
            { label: 'Agents', href: '/agents', icon: Bot },
            { label: 'Extensions', href: '/extensions', icon: Zap },
            { label: 'Functions', href: '/functions', icon: Wrench },
            { label: 'Connections', href: '/connections', icon: Plug },
            { label: 'Marketplace', href: '/marketplace', icon: Store },
        ],
    },
    {
        label: 'System',
        collapsible: true,
        defaultOpen: false,
        items: [
            { label: 'Workspace', href: '/settings', icon: SettingsIcon, exact: true },
            { label: 'Users', href: '/settings/users', icon: Users },
            { label: 'AI Providers', href: '/settings/ai-providers', icon: Cpu },
            { label: 'Intelligence', href: '/settings/intelligence', icon: BrainCircuit },
            { label: 'Agent', href: '/settings/agent', icon: Bot },
            { label: 'Behavior', href: '/settings/behavior', icon: Palette },
            { label: 'Channels', href: '/settings/channels', icon: Radio },
            { label: 'Voice', href: '/settings/voice', icon: Mic },
            { label: 'Memory', href: '/insights', icon: Brain },
            { label: 'Cron Jobs', href: '/cron', icon: Clock },
            { label: 'Audit Trail', href: '/audit', icon: FileText },
            { label: 'Privacy', href: '/settings/privacy', icon: ShieldCheck },
            { label: 'Logs', href: '/logs', icon: FileText },
            { label: 'Debug', href: '/debug', icon: Terminal },
        ],
    },
]

const STORAGE_KEY = 'plexo:sidebar:collapse'
const SIDEBAR_STATE_KEY = 'plexo:sidebar:global-collapse'


function loadCollapsedState(groups: NavGroup[]): Record<string, boolean> {
    const initial: Record<string, boolean> = {}
    groups.forEach((g) => {
        initial[g.label] = !g.defaultOpen
    })

    if (typeof window === 'undefined') return initial

    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return initial
        const saved = JSON.parse(raw) as Record<string, boolean>
        return { ...initial, ...saved }
    } catch {
        return initial
    }
}

import { ArrowUpCircle } from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'
import { ThemeToggle } from '@web/components/theme-toggle'

// ── WorkspaceSwitcher ──────────────────────────────────────────────────────────

interface WorkspaceSummary {
    id: string
    name: string
}

const VERSION = `v${process.env.NEXT_PUBLIC_APP_VERSION ?? '0.8.0-beta.1'}`
const BUILD_TIME_SHA = process.env.NEXT_PUBLIC_SOURCE_COMMIT
    && process.env.NEXT_PUBLIC_SOURCE_COMMIT !== 'unknown'
    ? process.env.NEXT_PUBLIC_SOURCE_COMMIT.slice(0, 7)
    : null

function WorkspaceSwitcher({ className = '', collapsed = false }: { className?: string; collapsed?: boolean }) {
    const { workspaceId, workspaceName, setWorkspace } = useWorkspace()
    const [open, setOpen] = useState(false)
    const [updateAvailable, setUpdateAvailable] = useState(false)

    // Listen for behind-state broadcasts from UpdateModal
    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent).detail as { behind: boolean } | undefined
            setUpdateAvailable(detail?.behind ?? false)
        }
        window.addEventListener('plexo:update-status', handler)
        return () => window.removeEventListener('plexo:update-status', handler)
    }, [])

    // Runtime fallback: fetch commit hash from version API if not baked at build time
    const [runtimeSha, setRuntimeSha] = useState<string | null>(null)
    useEffect(() => {
        if (BUILD_TIME_SHA) return
        fetch('/api/v1/system/version')
            .then(r => r.ok ? r.json() : null)
            .then((d: { sourceCommit?: string } | null) => {
                if (d?.sourceCommit) setRuntimeSha(d.sourceCommit)
            })
            .catch(() => {})
    }, [])
    const SHORT_SHA = BUILD_TIME_SHA ?? runtimeSha
    const [list, setList] = useState<WorkspaceSummary[]>([])
    const [isLoading, setIsLoading] = useState(false)
    const [creating, setCreating] = useState(false)
    const [newName, setNewName] = useState('')
    const ref = useRef<HTMLDivElement>(null)

    // Fetch workspace list when dropdown opens
    useEffect(() => {
        if (!open) return
        setIsLoading(true)
        fetch('/api/v1/workspaces', { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : { items: [] })
            .then((d: unknown) => {
                setList(Array.isArray(d) ? d : ((d as { items?: WorkspaceSummary[] }).items ?? []))
                setIsLoading(false)
            })
            .catch(() => { setIsLoading(false) })
    }, [open])

    useEffect(() => {
        if (!open) return
        function handler(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    async function handleCreate() {
        if (!newName.trim()) return
        // Need the current user's id as ownerId — read from the first workspace as a proxy
        const ownerRes = await fetch(`/api/v1/workspaces/${workspaceId}`)
        const ownerData = await (ownerRes.ok ? ownerRes.json() : {}) as { ownerId?: string }
        const ownerId = ownerData.ownerId ?? workspaceId  // fallback to workspace id if unknown
        const res = await fetch(`/api/v1/workspaces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: newName.trim(), ownerId }),
        })
        if (res.ok) {
            const created = await res.json() as WorkspaceSummary
            setWorkspace(created.id, created.name)
        }
        setCreating(false)
        setNewName('')
        setOpen(false)
    }

    const displayName = workspaceName || 'Workspace'
    const isNameLoading = !workspaceName

    return (
        <div ref={ref} className="relative">
            <button
                id="workspace-switcher"
                onClick={() => setOpen((o) => !o)}
                className={`flex min-h-[64px] h-16 w-full items-center ${collapsed ? "justify-center" : "gap-3 px-3"} hover:bg-surface-1/60 transition-colors cursor-pointer ${className}`}
            >
                {/* App icon */}
                <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-azure/10 ring-1 ring-inset ring-azure/20">
                    <PlexoMark className="w-7 h-7 text-azure" />
                    {updateAvailable && collapsed && (
                        <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-azure ring-2 ring-canvas animate-pulse" />
                    )}
                </div>
                {!collapsed && (
                    <>
                        <div className="flex min-w-0 flex-col text-left gap-0.5 min-h-[36px] justify-center">
                            {isNameLoading ? (
                                <span className="h-[18px] w-24 rounded bg-surface-2 animate-pulse" />
                            ) : (
                                <span className="text-[15px] font-semibold leading-tight tracking-tight text-text-primary truncate cursor-pointer">{displayName}</span>
                            )}
                            <span className="text-[11px] text-text-secondary font-mono leading-none opacity-70 min-h-[14px]">{VERSION}{SHORT_SHA ? ` · ${SHORT_SHA}` : ''}</span>
                        </div>
                        <div className="ml-auto flex items-center gap-1.5 shrink-0">
                            {updateAvailable && (
                                <span
                                    role="button"
                                    tabIndex={0}
                                    title="Update available — click to install"
                                    onClick={(e) => { e.stopPropagation(); window.dispatchEvent(new CustomEvent('plexo:check-update')) }}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); window.dispatchEvent(new CustomEvent('plexo:check-update')); } }}
                                    className="flex items-center gap-1 rounded-full px-2 py-0.5 bg-azure/15 ring-1 ring-inset ring-azure/25 cursor-pointer hover:bg-azure/25 transition-colors"
                                >
                                    <ArrowUpCircle className="h-3 w-3 text-azure shrink-0" />
                                    <span className="text-[10px] text-azure font-semibold uppercase tracking-wide">Update</span>
                                </span>
                            )}
                            <ChevronsUpDown className="h-3.5 w-3.5 text-text-muted" />
                        </div>
                    </>
                )}
            </button>

            {open && (
                <div className="absolute left-2 top-[calc(100%+4px)] z-50 w-[240px] rounded-xl border border-border bg-surface-1 shadow-2xl shadow-black/20 overflow-hidden">
                    {/* Workspace list */}
                    <div className="max-h-80 overflow-y-auto p-1.5 space-y-0.5">
                        {isLoading && list.length === 0 && (
                            <p className="px-3 py-3 text-sm text-text-muted">Loading…</p>
                        )}
                        {!isLoading && list.length === 0 && (
                            <p className="px-3 py-3 text-sm text-text-muted">No workspaces</p>
                        )}
                        {list.map((ws) => (
                            <button
                                key={ws.id}
                                onClick={(e) => {
                                    e.stopPropagation()
                                    if (ws.id !== workspaceId) {
                                        setWorkspace(ws.id, ws.name)
                                        return // reload will follow — skip setOpen
                                    }
                                    setOpen(false)
                                }}
                                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-surface-2 transition-colors"
                            >
                                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-azure/20 text-sm font-bold text-azure uppercase pb-[1px]">
                                    {ws.name.slice(0, 1)}
                                </div>
                                <span className="flex-1 truncate text-sm font-medium text-text-primary">{ws.name}</span>
                                {ws.id === workspaceId && <Check className="h-4 w-4 text-azure shrink-0" />}
                            </button>
                        ))}
                    </div>

                    <div className="border-t border-border p-1">
                        {creating ? (
                            <div className="flex items-center gap-1 px-1 py-1">
                                <input
                                    autoFocus
                                    value={newName}
                                    onChange={(e) => setNewName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void handleCreate()
                                        if (e.key === 'Escape') { setCreating(false); setNewName('') }
                                    }}
                                    placeholder="Workspace name"
                                    className="flex-1 rounded-md border border-border bg-canvas px-2 py-1 text-[12px] text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                                />
                                <button
                                    onClick={() => void handleCreate()}
                                    className="rounded-md bg-azure px-2 py-1 text-[11px] font-semibold text-white hover:bg-azure/90"
                                >
                                    Add
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={() => setCreating(true)}
                                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-3 text-sm font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                            >
                                <Plus className="h-4 w-4" />
                                New workspace
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}


function RecentChats({ collapsed, onNavClick }: { collapsed: boolean; onNavClick?: () => void }) {
    const { workspaceId } = useWorkspace()
    const [chats, setChats] = useState<{ id: string; message: string; sessionId: string | null }[]>([])
    const [loaded, setLoaded] = useState(false)

    useEffect(() => {
        if (!workspaceId) return
        const api = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')
        fetch(`${api}/api/v1/conversations?workspaceId=${encodeURIComponent(workspaceId)}&limit=5&groupBySession=true`, { cache: 'no-store' })
            .then(res => res.ok ? res.json() : { items: [] })
            .then((data: { items?: { id: string; message: string; sessionId: string | null }[] }) =>
                setChats(Array.isArray(data.items) ? data.items.slice(0, 5) : []))
            .catch(() => {})
            .finally(() => setLoaded(true))
    }, [workspaceId])

    if (loaded && chats.length === 0) return null

    return (
        <div className="mb-4 min-h-[120px]">
            {!collapsed && (
                <div className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted/60">
                    Recent
                </div>
            )}
            <div className="space-y-0.5 px-1 md:px-0">
                {!loaded && !collapsed && Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5">
                        <div className="h-4 w-4 shrink-0 rounded bg-surface-2 animate-pulse" />
                        <div className="h-3 rounded bg-surface-2 animate-pulse" style={{ width: `${55 + i * 8}%` }} />
                    </div>
                ))}
                {chats.map(chat => {
                    const href = chat.sessionId 
                        ? `/conversations/thread?sessionId=${encodeURIComponent(chat.sessionId)}`
                        : `/conversations/${encodeURIComponent(chat.id)}`
                    return (
                        <Link
                            key={chat.id}
                            href={href}
                            onClick={onNavClick}
                            className={`group flex items-center justify-center md:justify-start gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors border-transparent text-text-muted hover:bg-surface-1 hover:text-text-secondary`}
                            title={collapsed ? chat.message : undefined}
                        >
                            <MessageCircle className="h-4 w-4 shrink-0 text-text-muted group-hover:text-text-secondary" />
                            {!collapsed && (
                                <span className="flex-1 truncate leading-tight font-normal">{chat.message}</span>
                            )}
                        </Link>
                    )
                })}
            </div>
        </div>
    )
}


export function Sidebar({ user, onNavClick, className = '' }: { user?: SessionUser; onNavClick?: () => void; className?: string }) {
    const pathname = usePathname()
    const { workspaceId } = useWorkspace()
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
        // SSR safe — defaultOpen values only
        const init: Record<string, boolean> = {}
        NAV_GROUPS.forEach((g) => { init[g.label] = !g.defaultOpen })
        return init
    })
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

    // Read sidebar collapse state BEFORE paint to prevent width flash
    useIsomorphicLayoutEffect(() => {
        try {
            const raw = localStorage.getItem(SIDEBAR_STATE_KEY)
            if (raw === 'true') setSidebarCollapsed(true)
        } catch {}
    }, [])

    function toggleSidebar() {
        setSidebarCollapsed(prev => {
            const next = !prev
            try { localStorage.setItem(SIDEBAR_STATE_KEY, JSON.stringify(next)) } catch {}
            return next
        })
    }

    const [pendingApprovals, setPendingApprovals] = useState(0)
    const [blockedTasks, setBlockedTasks] = useState(0)
    const [pendingImprovements, setPendingImprovements] = useState(0)
    const [failedCronJobs, setFailedCronJobs] = useState(0)
    const [rsiPending, setRsiPending] = useState(0)
    const [systemWarning, setSystemWarning] = useState(false)
    const [capabilityWarning, setCapabilityWarning] = useState(false)

    const fetchCounts = useCallback(async () => {
        const wsId = workspaceId || process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE
        const api = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')
        if (!wsId) return

        try {
            // Approvals
            const appRes = await fetch(`${api}/api/v1/approvals?workspaceId=${wsId}`, { cache: 'no-store' })
            if (appRes.ok) {
                const data = await appRes.json() as { total?: number }
                setPendingApprovals(data.total ?? 0)
            }

            // Task Stats (for blocked tasks)
            const statsRes = await fetch(`${api}/api/v1/tasks/stats/summary?workspaceId=${wsId}`, { cache: 'no-store' })
            if (statsRes.ok) {
                const data = await statsRes.json() as { byStatus?: Record<string, number> }
                setBlockedTasks(data.byStatus?.blocked ?? 0)
            }

            // Improvements (Memory)
            const impRes = await fetch(`${api}/api/v1/memory/improvements?workspaceId=${wsId}&limit=100`, { cache: 'no-store' })
            if (impRes.ok) {
                const data = await impRes.json() as { items?: { applied: boolean }[] }
                const pending = data.items?.filter(it => !it.applied).length ?? 0
                setPendingImprovements(pending)
            }

            // Cron Jobs
            const cronRes = await fetch(`${api}/api/v1/cron?workspaceId=${wsId}`, { cache: 'no-store' })
            if (cronRes.ok) {
                const data = await cronRes.json() as { items?: { lastRunStatus: string; consecutiveFailures: number }[] }
                const failed = data.items?.filter(it => it.lastRunStatus === 'failure' || it.consecutiveFailures > 0).length ?? 0
                setFailedCronJobs(failed)
            }
        } catch { /* non-critical badge counts */ }
    }, [workspaceId])

    const fetchHealth = useCallback(async () => {
        const wsId = workspaceId || process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE
        const api = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')
        try {
            const res = await fetch(`${api}/api/v1/health`, { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json() as { status: string; services: { ai: { ok: boolean | null } } }
                const aiFailed = data.services.ai.ok === false
                setSystemWarning(data.status === 'degraded' || aiFailed)
            }

            // Check RSI Proposals
            if (wsId) {
                const rsiRes = await fetch(`${api}/api/v1/workspaces/${wsId}/rsi/proposals`, { cache: 'no-store' })
                if (rsiRes.ok) {
                    const rsiData = await rsiRes.json() as { items: { status: string }[] }
                    const pending = rsiData.items.filter(it => it.status === 'pending').length
                    setRsiPending(pending)
                }
            }

            // Check Capabilities Health (Installed Connections)
            if (wsId) {
                const connRes = await fetch(`${api}/api/v1/connections/installed?workspaceId=${wsId}`, { cache: 'no-store' })
                if (connRes.ok) {
                    const connData = await connRes.json() as { items: { status: string }[] }
                    const hasDisconnected = connData.items.some(it => it.status === 'disconnected')
                    setCapabilityWarning(hasDisconnected)
                }
            }
        } catch { /* non-critical health check */ }
    }, [workspaceId])

    useEffect(() => {
        void fetchCounts()
        void fetchHealth()
        const ivCounts = setInterval(() => void fetchCounts(), 10_000)
        const ivHealth = setInterval(() => void fetchHealth(), 30_000)
        return () => {
            clearInterval(ivCounts)
            clearInterval(ivHealth)
        }
    }, [fetchCounts, fetchHealth])

    // Load persisted collapse state BEFORE paint to prevent section flash
    useIsomorphicLayoutEffect(() => {
        setCollapsed(loadCollapsedState(NAV_GROUPS))
    }, [])

    function toggleGroup(label: string) {
        setCollapsed((prev) => {
            const currentlyCollapsed = prev[label] ?? true
            const isOpening = currentlyCollapsed
            let next = { ...prev }

            // If we are opening a management group, close all other management groups
            if (isOpening) {
                NAV_GROUPS.forEach((g) => {
                    if (g.label !== label) {
                        next[g.label] = true // True means collapsed
                    }
                })
            }

            next[label] = !currentlyCollapsed

            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* localStorage unavailable in some contexts */ }
            return next
        })
    }

    function getGroupStatus(groupLabel: string) {
        if (groupLabel === 'Work') return (pendingApprovals > 0 || blockedTasks > 0) ? 'warning' : null
        if (groupLabel === 'Capabilities') return (capabilityWarning || pendingImprovements > 0 || failedCronJobs > 0) ? 'warning' : null
        if (groupLabel === 'System') return (systemWarning || rsiPending > 0) ? 'warning' : null
        return null
    }

    function isActive(href: string, exact?: boolean): boolean {
        if (href === '/' || exact) return pathname === href
        return pathname === href || pathname.startsWith(href + '/')
    }

    return (
        <>
        <aside className={`hidden md:flex flex-col shrink-0 border-r border-border-subtle bg-canvas transition-all duration-300 ${sidebarCollapsed ? 'w-[68px]' : 'w-[220px]'}`}>
            <div className={`relative group/collapse ${sidebarCollapsed ? 'border-b border-border-subtle' : ''}`}>
                <WorkspaceSwitcher collapsed={sidebarCollapsed} className={!sidebarCollapsed ? 'border-b border-border-subtle' : ''} />
                {!sidebarCollapsed && (
                    <button onClick={toggleSidebar} className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 p-1.5 bg-surface-1 rounded-md text-text-muted hover:text-text-primary z-10 hidden md:flex items-center justify-center group-hover/collapse:opacity-100 transition-opacity ring-1 ring-inset ring-border/50 shadow-sm" title="Collapse Sidebar">
                        <PanelLeftClose className="h-4 w-4" />
                    </button>
                )}
            </div>

            <nav className="flex-1 flex flex-col min-h-0 py-2 overflow-y-auto scrollbar-none relative">
                {sidebarCollapsed && (
                    <button onClick={toggleSidebar} className="mx-auto my-1.5 p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-2 rounded-md transition-colors" title="Expand Sidebar">
                        <PanelLeftOpen className="h-4 w-4" />
                    </button>
                )}
                
                {/* Primary Groups (Home, Chat, Conversations) */}
                <div className={`px-2 md:px-3 space-y-0.5 mb-6 ${sidebarCollapsed ? 'mt-2' : ''}`}>
                    {[
                        { label: 'Home', href: '/', icon: Home, exact: true },
                        { label: 'New Chat', href: '/chat', icon: MessageSquare },
                        { label: 'Conversations', href: '/conversations', icon: MessagesSquare },
                    ].map(({ label, href, icon: Icon, exact }) => {
                        const active = isActive(href, exact)
                        return (
                            <Link
                                key={href}
                                href={href}
                                onClick={onNavClick}
                                title={sidebarCollapsed ? label : undefined}
                                className={`group flex items-center justify-center md:justify-start gap-2.5 rounded-lg text-[13px] font-medium transition-colors border-l-2 ${sidebarCollapsed ? 'p-2 my-0.5 border-none' : 'px-2.5 py-2'} ${active
                                    ? (sidebarCollapsed ? 'bg-azure/10 text-azure' : 'border-azure bg-azure/10 text-text-primary')
                                    : 'border-transparent text-text-muted hover:bg-surface-1 hover:text-text-secondary'
                                    }`}
                            >
                                <Icon
                                    className={`h-4 w-4 shrink-0 ${active
                                        ? 'text-azure'
                                        : 'text-text-muted group-hover:text-text-secondary'
                                        }`}
                                />
                                {!sidebarCollapsed && <span className="flex-1 truncate">{label}</span>}
                            </Link>
                        )
                    })}
                </div>

                <div className="px-2 md:px-3 mb-2">
                    <RecentChats collapsed={sidebarCollapsed} onNavClick={onNavClick} />
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Management / System Section (Bottom) */}
                <div className={`px-2 md:px-3 pb-2 pt-4 ${sidebarCollapsed ? '' : 'border-t border-border-subtle/50'} bg-surface-1/10`}>
                    {NAV_GROUPS.map((group) => {
                        const isCollapsed = collapsed[group.label] ?? !group.defaultOpen
                        return (
                            <div key={group.label} className={sidebarCollapsed ? "mb-4 border-b border-border/20 pb-4 last:border-0 last:mb-0 last:pb-0" : "mb-0.5"}>
                                {sidebarCollapsed && getGroupStatus(group.label) && (
                                    <div className="flex justify-center mb-1">
                                        <div className="h-1.5 w-1.5 rounded-full bg-red animate-pulse" />
                                    </div>
                                )}
                                {/* Group header — always rendered in expanded sidebar */}
                                {!sidebarCollapsed && (
                                    <div
                                        className={`flex items-center justify-between rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2 ${group.collapsible ? 'cursor-pointer' : ''}`}
                                        onClick={() => group.collapsible && toggleGroup(group.label)}
                                    >
                                        <div className="flex items-center gap-2">
                                            <span className="text-[11px] font-semibold text-text-muted uppercase tracking-tight">
                                                {group.label}
                                            </span>
                                            {/* Pulse shown regardless of collapsed state — visible even when section is folded */}
                                            {getGroupStatus(group.label) && (
                                                <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
                                            )}
                                        </div>
                                        {group.collapsible && (
                                            <span className="text-text-muted/60">
                                                {isCollapsed
                                                    ? <ChevronRight className="h-3 w-3" />
                                                    : <ChevronDown className="h-3 w-3" />
                                                }
                                            </span>
                                        )}
                                    </div>
                                )}

                                {/* Group items */}
                                {(!isCollapsed || sidebarCollapsed) && (
                                    <div className={sidebarCollapsed ? "space-y-1 mt-1" : "mt-0.5 ml-2 space-y-0.5 border-l border-border/40 pl-2"}>
                                        {group.items.map(({ label, href, icon: Icon, exact }) => {
                                            const active = isActive(href, exact)
                                            return (
                                                <Link
                                                    key={href}
                                                    href={href}
                                                    onClick={onNavClick}
                                                    title={sidebarCollapsed ? label : undefined}
                                                    className={`group flex relative items-center justify-center md:justify-start gap-2.5 rounded-lg text-[12px] font-medium transition-colors ${sidebarCollapsed ? 'p-2' : 'px-2.5 py-1.5'} ${active
                                                        ? 'bg-azure/10 text-azure'
                                                        : 'text-text-muted hover:bg-surface-1 hover:text-text-secondary'
                                                        }`}
                                                >
                                                    <Icon
                                                        className={`h-[15px] w-[15px] shrink-0 ${active
                                                            ? 'text-azure'
                                                            : 'text-text-muted group-hover:text-text-secondary'
                                                            }`}
                                                    />
                                                    {!sidebarCollapsed && <span className="flex-1 truncate">{label}</span>}
                                                    {/* Approvals Badge */}
                                                    {href === '/approvals' && pendingApprovals > 0 && !sidebarCollapsed && (
                                                        <span className="shrink-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                                                            {pendingApprovals}
                                                        </span>
                                                    )}
                                                    {href === '/approvals' && pendingApprovals > 0 && sidebarCollapsed && (
                                                        <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-red-500" />
                                                    )}

                                                    {/* Blocked Tasks Badge */}
                                                    {href === '/tasks' && blockedTasks > 0 && !sidebarCollapsed && (
                                                        <span className="shrink-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold text-black">
                                                            {blockedTasks}
                                                        </span>
                                                    )}
                                                    {href === '/tasks' && blockedTasks > 0 && sidebarCollapsed && (
                                                        <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
                                                    )}

                                                    {/* Memory / Improvements Badge */}
                                                    {href === '/insights' && pendingImprovements > 0 && !sidebarCollapsed && (
                                                        <span className="shrink-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-azure px-1 text-[9px] font-bold text-white">
                                                            {pendingImprovements}
                                                        </span>
                                                    )}
                                                    {href === '/insights' && pendingImprovements > 0 && sidebarCollapsed && (
                                                        <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-azure" />
                                                    )}

                                                    {/* Cron Jobs Badge */}
                                                    {href === '/cron' && failedCronJobs > 0 && !sidebarCollapsed && (
                                                        <span className="shrink-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                                                            {failedCronJobs}
                                                        </span>
                                                    )}
                                                    {href === '/cron' && failedCronJobs > 0 && sidebarCollapsed && (
                                                        <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-red-500" />
                                                    )}

                                                    {/* Integrations Warning */}
                                                    {href === '/settings/connections' && capabilityWarning && (
                                                        <span className={`h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse ${sidebarCollapsed ? 'absolute top-1.5 right-1.5' : 'ml-1'}`} />
                                                    )}

                                                    {/* AI Providers Warning */}
                                                    {href === '/settings/ai-providers' && systemWarning && (
                                                        <span className={`h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse ${sidebarCollapsed ? 'absolute top-1.5 right-1.5' : 'ml-1'}`} />
                                                    )}

                                                    {/* RSI Proposals / Accountability Badge */}
                                                    {(href === '/settings' || href === '/settings/intelligence') && rsiPending > 0 && !sidebarCollapsed && (
                                                        <span className="shrink-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-azure px-1 text-[9px] font-bold text-white">
                                                            {rsiPending}
                                                        </span>
                                                    )}
                                                    {(href === '/settings' || href === '/settings/intelligence') && rsiPending > 0 && sidebarCollapsed && (
                                                        <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-azure" />
                                                    )}
                                                </Link>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            </nav>

            {/* Footer */}
            <div className={`relative flex flex-col border-t border-border-subtle ${sidebarCollapsed ? 'p-2' : 'p-3'}`}>
                <UserFooter user={user} collapsed={sidebarCollapsed} />
            </div>
        </aside>

        </>
    )
}

function UserFooter({ user, collapsed }: { user?: SessionUser; collapsed?: boolean }) {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        function handler(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const initials = (user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase()

    return (
        <div ref={ref} className="relative w-full">
            <button
                onClick={() => setOpen((o) => !o)}
                className={`flex w-full items-center ${collapsed ? 'justify-center p-1' : 'gap-2.5 p-2'} rounded-lg text-left hover:bg-surface-1/80 transition-colors`}
                title={collapsed ? (user?.name ?? 'User') : undefined}
            >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[11px] font-semibold text-text-primary ring-1 ring-inset ring-border">
                    {initials}
                </div>
                {!collapsed && (
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-text-primary">{user?.name ?? 'User'}</p>
                        <p className="truncate text-[10px] text-text-muted">{user?.email ?? ''}</p>
                    </div>
                )}
            </button>

            {open && (
                <div className={`absolute bottom-[calc(100%+8px)] z-50 rounded-xl border border-border bg-surface-1 shadow-2xl shadow-black/20 overflow-hidden ${collapsed ? 'left-2 min-w-[220px]' : 'left-0 w-full'}`}>
                    {/* Identity header */}
                    <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-xs font-semibold text-text-primary ring-1 ring-inset ring-border">
                            {initials}
                        </div>
                        <div className="min-w-0">
                            <p className="truncate text-xs font-medium text-text-primary">{user?.name ?? 'User'}</p>
                            <p className="truncate text-[10px] text-text-muted">{user?.email ?? ''}</p>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="p-1">
                        <Link
                            href="/settings"
                            onClick={() => setOpen(false)}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                        >
                            <SettingsIcon className="h-3.5 w-3.5" />
                            Settings
                        </Link>
                        <div className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-[13px] text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors">
                            <div className="flex items-center gap-2">
                                <Palette className="h-3.5 w-3.5" />
                                Theme
                            </div>
                            <ThemeToggle />
                        </div>
                        <div className="my-1 border-t border-border" />
                        <button
                            onClick={() => { const sb = createClient(); void sb.auth.signOut().then(() => { window.location.href = '/login' }) }}
                            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-red-400 hover:bg-red-950/40 hover:text-red-300 transition-colors"
                        >
                            <LogOut className="h-3.5 w-3.5" />
                            Sign out
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
