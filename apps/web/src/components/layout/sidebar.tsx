// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, useCallback, useRef } from 'react'
import { signOut } from 'next-auth/react'
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
    Sparkles as _Sparkles, // kept for potential future use
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

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
        label: 'Chat',
        collapsible: false,
        defaultOpen: true,
        items: [
            { label: 'Chat', href: '/chat', icon: MessagesSquare },
            { label: 'Conversations', href: '/conversations', icon: MessageSquare },
        ],
    },
    {
        label: 'Control',
        collapsible: true,
        defaultOpen: false,
        items: [
            { label: 'Overview', href: '/', icon: LayoutDashboard },
            { label: 'Tasks', href: '/tasks', icon: CheckSquare },
            { label: 'Projects', href: '/projects', icon: FolderOpen },
            { label: 'Cron Jobs', href: '/cron', icon: Clock },
            { label: 'Approvals', href: '/approvals', icon: ShieldAlert },
        ],
    },
    {
        label: 'Agent',
        collapsible: true,
        defaultOpen: false,
        items: [
            { label: 'Integrations', href: '/settings/connections', icon: Plug },
            { label: 'Marketplace', href: '/marketplace', icon: Store },
            { label: 'Channels', href: '/settings/channels', icon: Radio },
            { label: 'Skills', href: '/skills', icon: Zap },
            { label: 'Tools', href: '/tools', icon: Wrench },
            { label: 'Memory', href: '/insights', icon: Brain },
        ],
    },
    {
        label: 'Settings',
        collapsible: true,
        defaultOpen: false,
        items: [
            { label: 'AI Providers', href: '/settings/ai-providers', icon: Cpu },
            { label: 'Intelligence', href: '/settings/intelligence', icon: BrainCircuit },
            { label: 'Voice', href: '/settings/voice', icon: Mic },
            { label: 'Agent', href: '/settings/agent', icon: Bot },
            { label: 'Workspace', href: '/settings', icon: SettingsIcon, exact: true },
            { label: 'Users', href: '/settings/users', icon: Users },
            { label: 'Privacy', href: '/settings/privacy', icon: ShieldCheck },
        ],
    },
    {
        label: 'System',
        collapsible: true,
        defaultOpen: false,
        items: [
            { label: 'Logs', href: '/logs', icon: FileText },
            { label: 'Debug', href: '/debug', icon: Terminal },
        ],
    },
]

const STORAGE_KEY = 'plexo:sidebar:collapse'

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

import { PlexoMark } from '@web/components/plexo-logo'
import { ThemeToggle } from '@web/components/theme-toggle'

// ── WorkspaceSwitcher ──────────────────────────────────────────────────────────

interface WorkspaceSummary {
    id: string
    name: string
}

const VERSION = `v${process.env.NEXT_PUBLIC_APP_VERSION ?? '0.8.0-beta.1'}`
const SHORT_SHA = process.env.NEXT_PUBLIC_SOURCE_COMMIT
    ? process.env.NEXT_PUBLIC_SOURCE_COMMIT.slice(0, 7)
    : null

function WorkspaceSwitcher({ className = '' }: { className?: string }) {
    const { workspaceId, workspaceName, setWorkspace } = useWorkspace()
    const [open, setOpen] = useState(false)
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

    // Close on outside click
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

    return (
        <div ref={ref} className="relative">
            <button
                id="workspace-switcher"
                onClick={() => setOpen((o) => !o)}
                className={`flex h-16 w-full items-center gap-3 px-3 hover:bg-surface-1/60 transition-colors ${className}`}
            >
                {/* App icon */}
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-azure/10 ring-1 ring-inset ring-azure/20">
                    <PlexoMark className="w-7 h-7 text-azure" />
                </div>
                <div className="flex min-w-0 flex-col text-left">
                    <span className="text-[15px] font-semibold leading-tight tracking-tight text-text-primary truncate">{displayName}</span>
                    <span className="text-[11px] text-text-muted leading-tight mt-0.5">{VERSION}</span>
                    {SHORT_SHA && (
                        <span className="text-[10px] text-text-muted/60 font-mono leading-tight">{SHORT_SHA}</span>
                    )}
                </div>
                <ChevronsUpDown className="ml-auto h-3.5 w-3.5 shrink-0 text-text-muted" />
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
                                onClick={() => {
                                    if (ws.id !== workspaceId) setWorkspace(ws.id, ws.name)
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

export function Sidebar({ user, onNavClick, className = '' }: { user?: SessionUser; onNavClick?: () => void; className?: string }) {
    const pathname = usePathname()
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
        // SSR safe — defaultOpen values only
        const init: Record<string, boolean> = {}
        NAV_GROUPS.forEach((g) => { init[g.label] = !g.defaultOpen })
        return init
    })
    const [pendingApprovals, setPendingApprovals] = useState(0)

    // Polling for pending approvals count
    const fetchPending = useCallback(async () => {
        const wsId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE
        const api = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
        if (!wsId) return
        try {
            const res = await fetch(`${api}/api/v1/approvals?workspaceId=${wsId}`, { cache: 'no-store' })
            if (!res.ok) return
            const data = await res.json() as { total?: number }
            setPendingApprovals(data.total ?? 0)
        } catch { /* ignore */ }
    }, [])

    useEffect(() => {
        void fetchPending()
        const iv = setInterval(() => void fetchPending(), 10_000)
        return () => clearInterval(iv)
    }, [fetchPending])

    // Load persisted collapse state after mount
    useEffect(() => {
        const state = loadCollapsedState(NAV_GROUPS)
        setTimeout(() => setCollapsed(state), 0)
    }, [])

    function toggleGroup(label: string) {
        setCollapsed((prev) => {
            const currentlyCollapsed = prev[label] ?? true
            const isOpening = currentlyCollapsed
            let next = { ...prev }

            // If we are opening a management group, close all other management groups
            if (isOpening && label !== 'Chat') {
                NAV_GROUPS.forEach((g) => {
                    if (g.label !== 'Chat' && g.label !== label) {
                        next[g.label] = true // True means collapsed
                    }
                })
            }

            next[label] = !currentlyCollapsed

            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
            return next
        })
    }

    function isActive(href: string, exact?: boolean): boolean {
        if (href === '/' || exact) return pathname === href
        // Segment-boundary match: /tasks matches /tasks/abc but NOT /taskssomething
        // Also avoids /settings matching /settings/agent
        return pathname === href || pathname.startsWith(href + '/')
    }

    return (
        <>
        <aside className="hidden md:flex h-screen w-[220px] shrink-0 flex-col border-r border-border-subtle bg-canvas">
            {/* Workspace switcher */}
            <WorkspaceSwitcher className="border-b border-border-subtle" />

            {/* Navigation */}
            <nav className="flex-1 flex flex-col min-h-0 py-2 overflow-y-auto scrollbar-none">
                {/* Primary Groups (Chat) */}
                <div className="px-3 space-y-0.5">
                    {NAV_GROUPS.filter(g => g.label === 'Chat').map((group) => {
                        return (
                            <div key={group.label} className="mb-4">
                                <div className="space-y-0.5">
                                    {group.items.map(({ label, href, icon: Icon, exact }) => {
                                        const active = isActive(href, exact)
                                        return (
                                            <Link
                                                key={href}
                                                href={href}
                                                onClick={onNavClick}
                                                className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors border-l-2 ${active
                                                    ? 'border-azure bg-azure/10 text-text-primary'
                                                    : 'border-transparent text-text-muted hover:bg-surface-1 hover:text-text-secondary'
                                                    }`}
                                            >
                                                <Icon
                                                    className={`h-4 w-4 shrink-0 ${active
                                                        ? 'text-azure'
                                                        : 'text-text-muted group-hover:text-text-secondary'
                                                        }`}
                                                />
                                                <span className="flex-1 truncate">{label}</span>
                                            </Link>
                                        )
                                    })}
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* Spacer */}
                <div className="flex-1" />

                {/* Management / System Section (Bottom) */}
                <div className="px-3 pb-2 pt-4 border-t border-border-subtle/50 bg-surface-1/10">
                    <div className="mb-2 px-2 text-[10px] font-bold uppercase tracking-[0.15em] text-text-muted/60">
                        Management
                    </div>
                    {NAV_GROUPS.filter(g => g.label !== 'Chat').map((group) => {
                        const isCollapsed = collapsed[group.label] ?? !group.defaultOpen
                        return (
                            <div key={group.label} className="mb-0.5">
                                {/* Group header */}
                                <div
                                    className={`flex items-center justify-between rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2 ${group.collapsible ? 'cursor-pointer' : ''}`}
                                    onClick={() => group.collapsible && toggleGroup(group.label)}
                                >
                                    <div className="flex items-center gap-2">
                                        <span className="text-[11px] font-semibold text-text-muted group-hover:text-text-secondary uppercase tracking-tight">
                                            {group.label}
                                        </span>
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

                                {/* Group items */}
                                {!isCollapsed && (
                                    <div className="mt-0.5 ml-2 space-y-0.5 border-l border-border/40 pl-2">
                                        {group.items.map(({ label, href, icon: Icon, exact }) => {
                                            const active = isActive(href, exact)
                                            return (
                                                <Link
                                                    key={href}
                                                    href={href}
                                                    onClick={onNavClick}
                                                    className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${active
                                                        ? 'bg-azure/10 text-azure'
                                                        : 'text-text-muted hover:bg-surface-1 hover:text-text-secondary'
                                                        }`}
                                                >
                                                    <Icon
                                                        className={`h-3.5 w-3.5 shrink-0 ${active
                                                            ? 'text-azure'
                                                            : 'text-text-muted group-hover:text-text-secondary'
                                                            }`}
                                                    />
                                                    <span className="flex-1 truncate">{label}</span>
                                                    {href === '/approvals' && pendingApprovals > 0 && (
                                                        <span className="shrink-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white">
                                                            {pendingApprovals}
                                                        </span>
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
            <div className="relative flex flex-col border-t border-border-subtle p-2">
                <UserFooter user={user} />
                <div className="mt-1 flex items-center justify-between px-2.5 pb-1">
                    <span className="text-[9px] font-medium text-text-muted">
                        &copy; 2026 Joeybuilt LLC
                    </span>
                    <ThemeToggle />
                </div>
            </div>
        </aside>

        {/* Mobile Top Header */}
        <header 
            className="md:hidden fixed top-0 left-0 right-0 z-40 flex items-center border-b border-border/60 bg-canvas/90 backdrop-blur-xl"
            style={{ 
                height: 'calc(56px + env(safe-area-inset-top))',
                paddingTop: 'env(safe-area-inset-top)'
            }}
        >
            <div className="flex-1 w-full max-w-[240px]">
                <WorkspaceSwitcher />
            </div>
            <ThemeToggle className="mr-3 shrink-0" />
        </header>

        {/* Mobile Bottom Tab Bar */}
        <nav 
            className="md:hidden fixed bottom-0 left-0 right-0 z-50 flex items-center justify-around border-t border-border/60 bg-canvas/90 backdrop-blur-xl px-1"
            style={{ 
                height: 'calc(72px + env(safe-area-inset-bottom))',
                paddingBottom: 'env(safe-area-inset-bottom)'
            }}
        >
            {[
                { label: 'Overview', href: '/', icon: LayoutDashboard, exact: true },
                { label: 'Chat', href: '/chat', icon: MessagesSquare, exact: false },
                { label: 'Tasks', href: '/tasks', icon: CheckSquare, exact: false },
                { label: 'Settings', href: '/settings', icon: SettingsIcon, exact: false },
            ].map(({ label, href, icon: Icon, exact }) => {
                const active = isActive(href, exact)
                return (
                    <Link
                        key={href}
                        href={href}
                        className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${active ? 'text-azure' : 'text-text-muted hover:text-text-secondary'
                            }`}
                    >
                        <div className={`flex items-center justify-center rounded-full p-1.5 ${active ? 'bg-azure/10' : 'bg-transparent'}`}>
                            <Icon className="h-[22px] w-[22px]" />
                        </div>
                        <span className="text-[10px] font-medium">{label}</span>
                    </Link>
                )
            })}
        </nav>
        </>
    )
}

function UserFooter({ user }: { user?: SessionUser }) {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    // Close on outside click
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
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen((o) => !o)}
                className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left hover:bg-surface-1/80 transition-colors"
            >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[11px] font-semibold text-text-primary ring-1 ring-inset ring-border">
                    {initials}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-text-primary">{user?.name ?? 'User'}</p>
                    <p className="truncate text-[10px] text-text-muted">{user?.email ?? ''}</p>
                </div>
            </button>

            {open && (
                <div className="absolute bottom-[calc(100%+4px)] left-0 z-50 w-full rounded-xl border border-border bg-surface-1 shadow-2xl shadow-black/20 overflow-hidden">
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
                        <button
                            onClick={() => void signOut({ callbackUrl: '/login' })}
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
