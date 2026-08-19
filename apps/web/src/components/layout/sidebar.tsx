// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { authClient } from '@web/lib/auth-client'
import { toast } from 'sonner'
import {
    MessagesSquare,
    CheckSquare,
    Plug,
    Brain,
    Bot,
    Settings as SettingsIcon,
    ChevronsUpDown,
    Plus,
    Check,
    LogOut,
    ExternalLink,
    Home,
    MessageCircle,
    PanelLeftClose,
    PanelLeftOpen,
    Palette,
    Zap,
    Search,
    Sparkles,
    ChevronRight,
    FileText,
    Bug,
    ShieldCheck,
} from 'lucide-react'
import { ArrowUpCircle } from 'lucide-react'
import { Activity } from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'
import { ThemeToggle } from '@web/components/theme-toggle'
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
    exact?: boolean
}

// NOTE: UX-016 — Accordion groups implemented. Drag-reorder deferred to post-beta.
// ── Flat nav items ───────────────────────────────────────────────────────────

// Home — always visible, not in a section
const NAV_HOME: NavItem = { label: 'Home', href: '/app', icon: Home, exact: true }

// Chat & conversation — recent chats render inside this section
const NAV_CHAT: NavItem[] = [
    { label: 'Conversations', href: '/app/conversations', icon: MessagesSquare },
]

// Work — daily operator loop
const NAV_WORK_GROUP = {
    label: 'Work',
    items: [
        { label: 'Tasks', href: '/app/tasks', icon: CheckSquare },
        { label: 'Memory', href: '/app/memory', icon: Brain },
    ] as NavItem[],
}
const NAV_WORK = NAV_WORK_GROUP.items

// Platform — agents, tools, integrations
const NAV_PLATFORM: NavItem[] = [
    { label: 'AI Models', href: '/app/settings/intelligence', icon: Sparkles },
    { label: 'Your Agent', href: '/app/agents', icon: Bot },
    { label: 'Live Agents', href: '/app/agents/live', icon: Activity },
    { label: 'Extensions', href: '/app/extensions', icon: Zap },
    { label: 'Connections', href: '/app/connections', icon: Plug },
]

// Ops — infrastructure dashboards. NOTE: the `/app/ops/*` pages do not exist in
// this web build (no static or dynamic routes), and there is no per-workspace
// "ops extension" signal to gate on (extensionTypeEnum has no `ops` type; the
// built-in ops extensions are api-side only). Rendering these links produced
// guaranteed 404s, so the section is removed until the dashboard pages ship.
// To restore: add the page routes under app/app/ops/ and re-add a NAV_OPS section.

// System — settings and admin
// UX-016: Federation, Debug, Audit, Schedules collapsed into Settings sub-pages.
// Audit removed from nav: `/app/audit` has no page (stale after the UX-016 refactor).
const NAV_SYSTEM: NavItem[] = [
    { label: 'Settings', href: '/app/settings', icon: SettingsIcon },
    { label: 'Logs', href: '/app/logs', icon: FileText },
]

// System — operator-only items (appended to NAV_SYSTEM when user is workspace owner)
const NAV_SYSTEM_OPERATOR: NavItem[] = [
    { label: 'App Grants', href: '/app/settings/app-grants', icon: ShieldCheck },
    { label: 'Debug', href: '/app/debug', icon: Bug },
]

const SIDEBAR_STATE_KEY = 'plexo:sidebar:global-collapse'
const SIDEBAR_SECTION_KEY = 'plexo:sidebar:open-section'

type SectionId = 'chat' | 'work' | 'platform' | 'ops' | 'system'

// Map path prefixes to section IDs for auto-expand
function sectionForPath(pathname: string): SectionId | null {
    if (pathname === '/app/conversations' || pathname.startsWith('/app/conversations/') || pathname.startsWith('/conversations/') || pathname === '/app/chat' || pathname.startsWith('/app/chat/')) return 'chat'
    if (
        pathname === '/app/tasks' || pathname.startsWith('/app/tasks/') ||
        pathname === '/app/memory' || pathname.startsWith('/app/memory/')
    ) return 'work'
    if (
        // AI Models entry now points at /app/settings/intelligence (UX-016)
        pathname === '/app/settings/intelligence' || pathname.startsWith('/app/settings/intelligence/') ||
        pathname === '/app/agents' || pathname.startsWith('/app/agents/') ||
        pathname === '/app/extensions' || pathname.startsWith('/app/extensions/') ||
        pathname === '/app/connections' || pathname.startsWith('/app/connections/')
    ) return 'platform'
    if (
        (pathname === '/app/settings' || pathname.startsWith('/app/settings/')) &&
        !pathname.startsWith('/app/settings/intelligence')
    ) return 'system'
    if (pathname === '/app/logs' || pathname.startsWith('/app/logs/')) return 'system'
    if (pathname === '/app/intelligence' || pathname.startsWith('/app/intelligence/')) return 'system'
    if (pathname === '/app/debug' || pathname.startsWith('/app/debug/')) return 'system'
    if (pathname.startsWith('/app/ops')) return 'ops'
    return null
}

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

    useEffect(() => {
        if (!open) return
        function handleKey(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                setOpen(false)
                ;(ref.current?.querySelector<HTMLElement>('#workspace-switcher'))?.focus()
            }
        }
        document.addEventListener('keydown', handleKey)
        return () => document.removeEventListener('keydown', handleKey)
    }, [open])

    async function handleCreate() {
        if (!newName.trim()) return
        const ownerRes = await fetch(`/api/v1/workspaces/${workspaceId}`)
        const ownerData = await (ownerRes.ok ? ownerRes.json() : {}) as { ownerId?: string }
        const ownerId = ownerData.ownerId ?? workspaceId
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

    const customAppName = process.env.NEXT_PUBLIC_APP_NAME
    const isCustomInstance = customAppName && customAppName !== 'Plexo'
    const displayName = isCustomInstance ? customAppName : (workspaceName || 'Workspace')
    const isNameLoading = !isCustomInstance && !workspaceName

    return (
        <div ref={ref} className="relative">
            <button
                id="workspace-switcher"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-haspopup="menu"
                className={`flex min-h-[64px] h-16 w-full items-center ${collapsed ? "justify-center" : "gap-3 px-3"} hover:bg-surface-1/60 transition-colors cursor-pointer ${className}`}
            >
                {/* App icon */}
                <div className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded bg-accent-muted border border-accent/20">
                    <PlexoMark className="w-7 h-7 text-azure" />
                    {updateAvailable && collapsed && (
                        <span className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-sm bg-azure ring-2 ring-canvas animate-pulse" />
                    )}
                </div>
                {!collapsed && (
                    <>
                        <div className="flex min-w-0 flex-col text-left gap-0.5 min-h-[36px] justify-center">
                            {isNameLoading ? (
                                <span className="h-[18px] w-24 rounded bg-surface-2 animate-pulse" />
                            ) : (
                                <span className={`${displayName.length > 16 ? 'text-[13px]' : 'text-[15px]'} font-semibold leading-tight tracking-tight text-text-primary truncate cursor-pointer`}>{displayName}</span>
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
                                    className="flex items-center gap-1 rounded-sm px-2 py-0.5 bg-azure/15 ring-1 ring-inset ring-azure/25 cursor-pointer hover:bg-azure/25 transition-colors"
                                >
                                    <ArrowUpCircle className="h-3 w-3 text-azure shrink-0" />
                                    <span className="text-[11px] text-azure font-semibold uppercase tracking-wide">Update</span>
                                </span>
                            )}
                            <ChevronsUpDown className="h-3.5 w-3.5 text-text-muted" />
                        </div>
                    </>
                )}
            </button>

            {open && (
                <div className="absolute left-2 top-[calc(100%+4px)] z-50 w-[240px] max-w-[calc(100vw-2rem)] rounded border border-border bg-surface-1 overflow-hidden">
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
                                        return
                                    }
                                    setOpen(false)
                                }}
                                className="flex w-full items-center gap-3 rounded px-3 py-3 text-left hover:bg-surface-2 transition-colors"
                            >
                                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-azure/20 text-sm font-medium text-azure uppercase pb-[1px]">
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
                                    className="flex-1 rounded-sm border border-border bg-canvas px-2 py-1 text-[12px] text-text-primary placeholder:text-text-muted focus:border-accent focus-ring"
                                />
                                <button
                                    onClick={() => void handleCreate()}
                                    className="rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent-dim"
                                >
                                    Add
                                </button>
                            </div>
                        ) : (
                            <button
                                onClick={() => setCreating(true)}
                                className="flex w-full items-center gap-2.5 rounded px-3 py-3 text-sm font-medium text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
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
        <div>
            {!collapsed && chats.length > 0 && (
                <div className="mb-1.5 px-3 text-[10px] font-medium uppercase tracking-[0.12em] text-text-muted/40">
                    Recent
                </div>
            )}
            <div className="space-y-0.5 px-1 md:px-0">
                {!loaded && !collapsed && Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-2.5 rounded px-2.5 py-1.5">
                        <div className="h-4 w-4 shrink-0 rounded bg-surface-2 animate-pulse" />
                        <div className="h-3 rounded bg-surface-2 animate-pulse" style={{ width: `${55 + i * 8}%` }} />
                    </div>
                ))}
                {chats.map(chat => {
                    const href = chat.sessionId
                        ? `/app/conversations/thread?sessionId=${encodeURIComponent(chat.sessionId)}`
                        : `/app/conversations/${encodeURIComponent(chat.id)}`
                    return (
                        <Link
                            key={chat.id}
                            href={href}
                            onClick={onNavClick}
                            className={`group flex items-center justify-center md:justify-start gap-2.5 rounded px-2.5 py-1.5 min-h-[44px] text-[13px] font-medium transition-colors border-transparent text-text-muted hover:bg-surface-1 hover:text-text-secondary`}
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


// ── Badge renderer (keeps badge logic centralized) ───────────────────────────

function NavBadge({ href, sidebarCollapsed, pendingApprovals, blockedTasks, pendingImprovements, capabilityWarning, rsiPending }: {
    href: string
    sidebarCollapsed: boolean
    pendingApprovals: number
    blockedTasks: number
    pendingImprovements: number
    capabilityWarning: boolean
    rsiPending: number
}) {
    // Approvals
    if (href === '/app/approvals' && pendingApprovals > 0) {
        return sidebarCollapsed
            ? <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-red-500" />
            : <span className="shrink-0 flex h-5 min-w-5 items-center justify-center rounded-sm bg-red-500 px-1 text-[10px] font-medium text-white">{pendingApprovals}</span>
    }
    // Blocked Tasks
    if (href === '/app/tasks' && blockedTasks > 0) {
        return sidebarCollapsed
            ? <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
            : <span className="shrink-0 flex h-5 min-w-5 items-center justify-center rounded-sm bg-amber-500 px-1 text-[10px] font-medium text-black">{blockedTasks}</span>
    }
    // Memory / Improvements
    if (href === '/app/memory' && pendingImprovements > 0) {
        return sidebarCollapsed
            ? <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-azure" />
            : <span className="shrink-0 flex h-5 min-w-5 items-center justify-center rounded-sm bg-azure px-1 text-[10px] font-medium text-white">{pendingImprovements}</span>
    }
    // Integrations Warning
    if (href === '/app/connections' && capabilityWarning) {
        return <span className={`h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse ${sidebarCollapsed ? 'absolute top-1.5 right-1.5' : 'ml-1'}`} />
    }
    // Settings RSI
    if (href === '/app/settings' && rsiPending > 0) {
        return sidebarCollapsed
            ? <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-azure" />
            : <span className="shrink-0 flex h-5 min-w-5 items-center justify-center rounded-sm bg-azure px-1 text-[10px] font-medium text-white">{rsiPending}</span>
    }
    return null
}


// ── NavLink ──────────────────────────────────────────────────────────────────

function NavLink({ item, active, sidebarCollapsed, onNavClick, badgeProps }: {
    item: NavItem
    active: boolean
    sidebarCollapsed: boolean
    onNavClick?: () => void
    badgeProps: Parameters<typeof NavBadge>[0]
}) {
    const Icon = item.icon
    const isNewChat = item.label === 'New Chat'
    // UI-audit Phase 8c — when a connection warning is active, the
    // Integrations entry links to the pre-filtered warnings view so the
    // user lands on exactly the broken connections instead of hunting.
    const hasConnectionsWarning = item.href === '/app/connections' && badgeProps.capabilityWarning
    const href = hasConnectionsWarning
        ? `${item.href}?filter=warnings`
        : item.href

    return (
        <Link
            href={href}
            onClick={(e) => {
                // New Chat gets a cache-bust param generated on click (not render)
                if (isNewChat) {
                    e.preventDefault()
                    window.location.href = `${item.href}?new=${Date.now()}`
                }
                onNavClick?.()
            }}
            title={sidebarCollapsed ? item.label : undefined}
            className={`group flex relative items-center justify-center md:justify-start gap-2.5 rounded text-sm font-medium transition-colors min-h-[44px] ${sidebarCollapsed ? 'p-2' : 'px-3 py-2'} ${active
                ? 'bg-surface-2 text-text-primary'
                : 'text-text-muted hover:bg-surface-1 hover:text-text-secondary'
                }`}
        >
            <Icon
                className={`h-[18px] w-[18px] shrink-0 ${active
                    ? 'text-text-primary'
                    : 'text-text-muted group-hover:text-text-secondary'
                    }`}
            />
            {!sidebarCollapsed && <span className="flex-1 truncate">{item.label}</span>}
            <NavBadge {...badgeProps} />
        </Link>
    )
}


// ── NavSection (collapsible accordion group) ────────────────────────────────

function NavSection({ id, label, expanded, onToggle, collapsed: sidebarCollapsed, children }: {
    id: SectionId
    label: string
    expanded: boolean
    onToggle: (id: SectionId) => void
    collapsed: boolean
    children: React.ReactNode
}) {
    if (sidebarCollapsed) return <>{children}</>

    return (
        <div>
            <button
                onClick={() => onToggle(id)}
                aria-expanded={expanded}
                aria-controls={`nav-section-${id}`}
                className="flex w-full items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-text-muted/60 cursor-pointer hover:text-text-muted transition-colors"
            >
                <ChevronRight
                    className={`h-3 w-3 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
                />
                {label}
            </button>
            <div
                id={`nav-section-${id}`}
                className="grid transition-[grid-template-rows] duration-200 ease-in-out"
                style={{ gridTemplateRows: expanded ? '1fr' : '0fr' }}
                {...(expanded ? {} : { inert: true })}
            >
                <div className="overflow-hidden">
                    <div className="space-y-0.5">
                        {children}
                    </div>
                </div>
            </div>
        </div>
    )
}


// ── Sidebar (main export) ────────────────────────────────────────────────────

export function Sidebar({ user, onNavClick, className = '', mobile = false }: { user?: SessionUser; onNavClick?: () => void; className?: string; mobile?: boolean }) {
    const pathname = usePathname()
    const { workspaceId, workspace } = useWorkspace()
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

    // Read sidebar collapse state BEFORE paint to prevent width flash
    useIsomorphicLayoutEffect(() => {
        if (mobile) return
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

    // Accordion section state — only one open at a time
    const [openSection, setOpenSection] = useState<SectionId | null>(null)

    // Hydrate from localStorage before paint
    useIsomorphicLayoutEffect(() => {
        try {
            const stored = localStorage.getItem(SIDEBAR_SECTION_KEY) as SectionId | null
            if (stored) {
                setOpenSection(stored)
            } else {
                // Default: auto-expand based on current path
                setOpenSection(sectionForPath(pathname) ?? 'chat')
            }
        } catch {
            setOpenSection(sectionForPath(pathname) ?? 'chat')
        }
    }, [])

    // Auto-expand section when navigating to a page within it
    useEffect(() => {
        const section = sectionForPath(pathname)
        if (section && section !== openSection) {
            setOpenSection(section)
            try { localStorage.setItem(SIDEBAR_SECTION_KEY, section) } catch {}
        }
    }, [pathname]) // eslint-disable-line react-hooks/exhaustive-deps

    function toggleSection(id: SectionId) {
        const next = openSection === id ? null : id
        setOpenSection(next)
        try { localStorage.setItem(SIDEBAR_SECTION_KEY, next ?? '') } catch {}
    }

    const [pendingApprovals, setPendingApprovals] = useState(0)
    const [blockedTasks, setBlockedTasks] = useState(0)
    const [pendingImprovements, setPendingImprovements] = useState(0)
    const [rsiPending, setRsiPending] = useState(0)
    const [systemWarning, setSystemWarning] = useState(false)
    const [capabilityWarning, setCapabilityWarning] = useState(false)
    const [isOperator, setIsOperator] = useState(false)

    // Detect workspace-owner (operator) status — gates Debug nav item.
    // Reads the shared workspace from context (single GET /workspaces/:id)
    // rather than issuing its own fetch.
    useEffect(() => {
        const ownerId = workspace?.ownerId
        if (!ownerId) return
        let cancelled = false
        ;(async () => {
            try {
                const session = await authClient.getSession()
                const userId = session.data?.user?.id
                if (!cancelled && userId && ownerId === userId) {
                    setIsOperator(true)
                }
            } catch { /* non-fatal */ }
        })()
        return () => { cancelled = true }
    }, [workspace?.ownerId])

    // Toast on state transitions — fire when counts increase, skip initial load
    const prevApprovals = useRef<number | null>(null)
    const prevBlocked = useRef<number | null>(null)
    const prevSystemWarning = useRef<boolean | null>(null)
    const prevCapabilityWarning = useRef<boolean | null>(null)

    useEffect(() => {
        if (prevApprovals.current !== null && pendingApprovals > prevApprovals.current) {
            toast.warning(`${pendingApprovals} task${pendingApprovals !== 1 ? 's' : ''} need${pendingApprovals === 1 ? 's' : ''} approval`, {
                description: 'Agent is waiting for your sign-off to continue.',
                action: { label: 'Review', onClick: () => { window.location.href = '/app/approvals' } },
                duration: 8000,
            })
        }
        prevApprovals.current = pendingApprovals
    }, [pendingApprovals])

    useEffect(() => {
        if (prevBlocked.current !== null && blockedTasks > prevBlocked.current) {
            toast.info(blockedTasks === 1 ? 'A task needs your input' : `${blockedTasks} tasks need attention`, {
                description: 'Some tasks could not complete automatically.',
                action: { label: 'Review', onClick: () => { window.location.href = '/app/tasks' } },
                duration: 6000,
            })
        }
        prevBlocked.current = blockedTasks
    }, [blockedTasks])

    useEffect(() => {
        if (prevSystemWarning.current !== null && systemWarning && !prevSystemWarning.current) {
            toast.error('System health degraded', {
                description: 'AI provider or core service is not responding.',
                action: { label: 'Logs', onClick: () => { window.location.href = '/app/logs' } },
                duration: 10000,
            })
        }
        prevSystemWarning.current = systemWarning
    }, [systemWarning])

    useEffect(() => {
        if (prevCapabilityWarning.current !== null && capabilityWarning && !prevCapabilityWarning.current) {
            toast.warning('An integration is disconnected', {
                description: 'One or more integrations have been disconnected.',
                action: { label: 'Fix', onClick: () => { window.location.href = '/app/settings/connections' } },
                duration: 8000,
            })
        }
        prevCapabilityWarning.current = capabilityWarning
    }, [capabilityWarning])

    const fetchCounts = useCallback(async () => {
        const wsId = workspaceId || process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE
        const api = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')
        if (!wsId) return

        try {
            const appRes = await fetch(`${api}/api/v1/approvals?workspaceId=${wsId}`, { cache: 'no-store' })
            if (appRes.ok) {
                const data = await appRes.json() as { total?: number }
                setPendingApprovals(data.total ?? 0)
            }

            const statsRes = await fetch(`${api}/api/v1/tasks/stats/summary?workspaceId=${wsId}`, { cache: 'no-store' })
            if (statsRes.ok) {
                const data = await statsRes.json() as { byStatus?: Record<string, number> }
                setBlockedTasks(data.byStatus?.blocked ?? 0)
            }

            const impRes = await fetch(`${api}/api/v1/memory/improvements?workspaceId=${wsId}&limit=100`, { cache: 'no-store' })
            if (impRes.ok) {
                const data = await impRes.json() as { items?: { applied: boolean }[] }
                const pending = data.items?.filter(it => !it.applied).length ?? 0
                setPendingImprovements(pending)
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

            if (wsId) {
                const rsiRes = await fetch(`${api}/api/v1/workspaces/${wsId}/rsi/proposals`, { cache: 'no-store' })
                if (rsiRes.ok) {
                    const rsiData = await rsiRes.json() as { items: { status: string }[] }
                    const pending = rsiData.items.filter(it => it.status === 'pending').length
                    setRsiPending(pending)
                }
            }

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

    function isActive(href: string, exact?: boolean): boolean {
        if (href === '/' || exact) return pathname === href
        return pathname === href || pathname.startsWith(href + '/')
    }

    const badgeProps = {
        sidebarCollapsed,
        pendingApprovals,
        blockedTasks,
        pendingImprovements,
        capabilityWarning,
        rsiPending,
    }

    function renderSection(items: NavItem[]) {
        return items.map((item) => (
            <NavLink
                key={item.href}
                item={item}
                active={isActive(item.href, item.exact)}
                sidebarCollapsed={sidebarCollapsed}
                onNavClick={onNavClick}
                badgeProps={{ ...badgeProps, href: item.href }}
            />
        ))
    }

    return (
        <aside className={`${mobile ? 'flex' : 'hidden md:flex'} flex-col shrink-0 border-r border-border-subtle bg-canvas transition-all duration-300 ${className} ${mobile ? 'w-full h-full' : sidebarCollapsed ? 'w-[68px]' : 'w-[248px]'}`}>
            <div className={`relative group/collapse ${sidebarCollapsed ? 'border-b border-border-subtle' : ''}`}>
                <WorkspaceSwitcher collapsed={sidebarCollapsed} className={!sidebarCollapsed ? 'border-b border-border-subtle' : ''} />
                {!sidebarCollapsed && (
                    <button onClick={toggleSidebar} aria-label="Collapse sidebar" className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 p-1.5 bg-surface-1 rounded-sm text-text-muted hover:text-text-primary z-10 hidden md:flex items-center justify-center group-hover/collapse:opacity-100 transition-opacity ring-1 ring-inset ring-border/50" title="Collapse Sidebar">
                        <PanelLeftClose className="h-4 w-4" />
                    </button>
                )}
            </div>

            <nav className="flex-1 flex flex-col min-h-0 py-2 overflow-y-auto [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:bg-border/40 [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-border/60 [scrollbar-width:thin] [scrollbar-color:var(--border)_transparent]">
                {sidebarCollapsed && (
                    <button onClick={toggleSidebar} aria-label="Expand sidebar" className="mx-auto my-1.5 p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-2 rounded-md transition-colors" title="Expand Sidebar">
                        <PanelLeftOpen className="h-4 w-4" />
                    </button>
                )}

                {/* Home — always visible */}
                <div className={`px-2 md:px-3 space-y-0.5 ${sidebarCollapsed ? 'mt-2' : ''}`}>
                    <NavLink
                        item={NAV_HOME}
                        active={isActive(NAV_HOME.href, NAV_HOME.exact)}
                        sidebarCollapsed={sidebarCollapsed}
                        onNavClick={onNavClick}
                        badgeProps={{ ...badgeProps, href: NAV_HOME.href }}
                    />
                </div>

                {/* Accordion sections */}
                <div className="px-2 md:px-3 mt-1 space-y-0.5">
                    <NavSection id="chat" label="Chat" expanded={openSection === 'chat'} onToggle={toggleSection} collapsed={sidebarCollapsed}>
                        {renderSection(NAV_CHAT)}
                        <RecentChats collapsed={sidebarCollapsed} onNavClick={onNavClick} />
                    </NavSection>

                    <NavSection id="work" label="Work" expanded={openSection === 'work'} onToggle={toggleSection} collapsed={sidebarCollapsed}>
                        {renderSection(NAV_WORK)}
                    </NavSection>

                    <NavSection id="platform" label="Platform" expanded={openSection === 'platform'} onToggle={toggleSection} collapsed={sidebarCollapsed}>
                        {renderSection(NAV_PLATFORM)}
                    </NavSection>

                    <NavSection id="system" label="System" expanded={openSection === 'system'} onToggle={toggleSection} collapsed={sidebarCollapsed}>
                        {renderSection(NAV_SYSTEM)}
                        {isOperator && renderSection(NAV_SYSTEM_OPERATOR)}
                    </NavSection>
                </div>

                {/* Spacer pushes footer down */}
                <div className="flex-1" />
            </nav>

            {/* Footer */}
            <div className={`relative flex flex-col border-t border-border-subtle ${sidebarCollapsed ? 'p-2' : 'p-3'}`}>
                {!sidebarCollapsed && (
                    <button
                        onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
                        className="flex items-center gap-2 rounded px-2.5 py-2 mb-1 text-[13px] text-text-muted hover:text-text-secondary hover:bg-surface-1/80 transition-colors"
                        aria-label="Open command palette"
                    >
                        <Search className="h-3.5 w-3.5" />
                        <span className="flex-1 text-left">Search...</span>
                        <kbd className="inline-flex items-center gap-0.5 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] font-mono">
                            ⌘K
                        </kbd>
                    </button>
                )}
                <UserFooter user={user} collapsed={sidebarCollapsed} />
            </div>
        </aside>
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

    useEffect(() => {
        if (!open) return
        function handleKey(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                setOpen(false)
                ;(ref.current?.querySelector<HTMLElement>('button'))?.focus()
            }
        }
        document.addEventListener('keydown', handleKey)
        return () => document.removeEventListener('keydown', handleKey)
    }, [open])

    const initials = (user?.name ?? user?.email ?? 'U').slice(0, 1).toUpperCase()

    return (
        <div ref={ref} className="relative w-full">
            <button
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-haspopup="menu"
                className={`flex w-full items-center ${collapsed ? 'justify-center p-1' : 'gap-2.5 p-2'} rounded text-left hover:bg-surface-1/80 transition-colors`}
                title={collapsed ? (user?.name ?? 'User') : undefined}
            >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-[11px] font-semibold text-text-primary ring-1 ring-inset ring-border">
                    {initials}
                </div>
                {!collapsed && (
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-medium text-text-primary">{user?.name ?? 'User'}</p>
                        <p className="truncate text-[11px] text-text-muted">{user?.email ?? ''}</p>
                    </div>
                )}
            </button>

            {open && (
                <div className={`absolute bottom-[calc(100%+8px)] z-50 rounded border border-border bg-surface-1 overflow-hidden ${collapsed ? 'left-2 min-w-[220px] max-w-[calc(100vw-1rem)]' : 'left-0 w-full max-w-[calc(100vw-1rem)]'}`}>
                    {/* Identity header */}
                    <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-border">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface-2 text-xs font-semibold text-text-primary ring-1 ring-inset ring-border">
                            {initials}
                        </div>
                        <div className="min-w-0">
                            <p className="truncate text-[13px] font-medium text-text-primary">{user?.name ?? 'User'}</p>
                            <p className="truncate text-[11px] text-text-muted">{user?.email ?? ''}</p>
                        </div>
                    </div>

                    {/* Actions */}
                    <div className="p-1">
                        <Link
                            href="/app/settings"
                            onClick={() => setOpen(false)}
                            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                        >
                            <SettingsIcon className="h-3.5 w-3.5" />
                            Settings
                        </Link>
                        <div className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors">
                            <div className="flex items-center gap-2">
                                <Palette className="h-3.5 w-3.5" />
                                Theme
                            </div>
                            <ThemeToggle />
                        </div>
                        <div className="my-1 border-t border-border" />
                        <button
                            onClick={async () => {
                                try {
                                    const res = await fetch('/api/v1/auth/handoff/generate', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ targetApp: 'levio' }),
                                        credentials: 'same-origin',
                                    })
                                    if (res.ok) {
                                        const { redirectUrl } = await res.json() as { redirectUrl: string }
                                        window.location.href = redirectUrl
                                    }
                                } catch { /* non-fatal */ }
                            }}
                            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open Levio
                        </button>
                        <button
                            onClick={async () => {
                                try {
                                    const res = await fetch('/api/v1/auth/handoff/generate', {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ targetApp: 'pushd' }),
                                        credentials: 'same-origin',
                                    })
                                    if (res.ok) {
                                        const { redirectUrl } = await res.json() as { redirectUrl: string }
                                        window.location.href = redirectUrl
                                    }
                                } catch { /* non-fatal */ }
                            }}
                            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-sm text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Open Pushd
                        </button>
                        <div className="my-1 border-t border-border" />
                        <button
                            onClick={() => { void authClient.signOut().then(() => { window.location.href = '/login' }) }}
                            className="flex w-full items-center gap-2 rounded px-2.5 py-2 text-sm text-red-400 hover:bg-red-dim hover:text-red-300 transition-colors"
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
