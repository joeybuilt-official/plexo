'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, useEffect, useCallback } from 'react'
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
    Cpu,
    Bot,
    Settings as SettingsIcon,
    Users,
    FileText,
    Terminal,
    ChevronDown,
    ChevronRight,
    ShieldAlert,
} from 'lucide-react'

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
        defaultOpen: true,
        items: [
            { label: 'Overview', href: '/', icon: LayoutDashboard },
            { label: 'Tasks', href: '/tasks', icon: CheckSquare },
            { label: 'Projects', href: '/sprints', icon: FolderOpen },
            { label: 'Cron Jobs', href: '/cron', icon: Clock },
            { label: 'Approvals', href: '/approvals', icon: ShieldAlert },
        ],
    },
    {
        label: 'Agent',
        collapsible: true,
        defaultOpen: true,
        items: [
            { label: 'Connections', href: '/settings/connections', icon: Plug },
            { label: 'Channels', href: '/settings/channels', icon: Radio },
            { label: 'Plugins', href: '/marketplace', icon: Store },
            { label: 'Memory', href: '/insights', icon: Brain },
        ],
    },
    {
        label: 'Settings',
        collapsible: true,
        defaultOpen: false,
        items: [
            { label: 'AI Providers', href: '/settings/ai-providers', icon: Cpu },
            { label: 'Agent', href: '/settings/agent', icon: Bot },
            { label: 'Workspace', href: '/settings', icon: SettingsIcon, exact: true },
            { label: 'Users', href: '/settings/users', icon: Users },
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

export function Sidebar() {
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
        const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
        if (!wsId) return
        try {
            const res = await fetch(`${api}/api/approvals?workspaceId=${wsId}`, { cache: 'no-store' })
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
        setCollapsed(loadCollapsedState(NAV_GROUPS))
    }, [])

    function toggleGroup(label: string) {
        setCollapsed((prev) => {
            const next = { ...prev, [label]: !prev[label] }
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
        <aside className="flex h-screen w-[220px] shrink-0 flex-col border-r border-zinc-800/50 bg-zinc-950">
            {/* Logo */}
            <div className="flex h-14 items-center gap-2.5 px-5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-xs font-bold text-white">
                    P
                </div>
                <span className="text-sm font-semibold tracking-tight">Plexo</span>
                <span className="ml-auto rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    v0.7
                </span>
            </div>

            {/* Navigation */}
            <nav className="flex-1 overflow-y-auto px-3 py-2">
                {NAV_GROUPS.map((group) => {
                    const isCollapsed = collapsed[group.label] ?? !group.defaultOpen
                    return (
                        <div key={group.label} className="mb-1">
                            {/* Group header */}
                            <div
                                className={`flex items-center justify-between px-2 py-1 mb-0.5 ${group.collapsible ? 'cursor-pointer' : ''}`}
                                onClick={() => group.collapsible && toggleGroup(group.label)}
                            >
                                <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                                    {group.label}
                                </span>
                                {group.collapsible && (
                                    <span className="text-zinc-700">
                                        {isCollapsed
                                            ? <ChevronRight className="h-3 w-3" />
                                            : <ChevronDown className="h-3 w-3" />
                                        }
                                    </span>
                                )}
                            </div>

                            {/* Group items */}
                            {!isCollapsed && (
                                <div className="space-y-0.5">
                                    {group.items.map(({ label, href, icon: Icon, exact }) => {
                                        const active = isActive(href, exact)
                                        return (
                                            <Link
                                                key={href}
                                                href={href}
                                                className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors border-l-2 ${active
                                                    ? 'border-indigo-500 bg-zinc-800/80 text-zinc-100'
                                                    : 'border-transparent text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                                                    }`}
                                            >
                                                <Icon
                                                    className={`h-4 w-4 shrink-0 ${active
                                                        ? 'text-indigo-400'
                                                        : 'text-zinc-600 group-hover:text-zinc-400'
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
            </nav>

            {/* Footer */}
            <div className="border-t border-zinc-800/50 px-3 py-3">
                <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-medium text-zinc-400">
                        A
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-zinc-300">Admin</p>
                        <p className="truncate text-[10px] text-zinc-600">admin@plexo.dev</p>
                    </div>
                </div>
            </div>
        </aside>
    )
}
