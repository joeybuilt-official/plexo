'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
    LayoutDashboard,
    MessageSquare,
    CheckSquare,
    Zap,
    Brain,
    Store,
    Settings,
    FileText,
} from 'lucide-react'

const NAV = [
    { label: 'Home', href: '/', icon: LayoutDashboard },
    { label: 'Conversations', href: '/conversations', icon: MessageSquare },
    { label: 'Tasks', href: '/tasks', icon: CheckSquare },
    { label: 'Sprints', href: '/sprints', icon: Zap },
    { label: 'Insights', href: '/insights', icon: Brain },
    { label: 'Marketplace', href: '/marketplace', icon: Store },
    { label: 'Settings', href: '/settings', icon: Settings },
    { label: 'Logs', href: '/logs', icon: FileText },
] as const

export function Sidebar() {
    const pathname = usePathname()

    return (
        <aside className="flex h-screen w-[220px] shrink-0 flex-col border-r border-zinc-800/50 bg-zinc-950">
            {/* Logo */}
            <div className="flex h-14 items-center gap-2.5 px-5">
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 text-xs font-bold text-white">
                    P
                </div>
                <span className="text-sm font-semibold tracking-tight">Plexo</span>
                <span className="ml-auto rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                    v0.1.0
                </span>
            </div>

            {/* Navigation */}
            <nav className="flex-1 space-y-0.5 px-3 py-2">
                {NAV.map(({ label, href, icon: Icon }) => {
                    const isActive =
                        href === '/' ? pathname === '/' : pathname.startsWith(href)
                    return (
                        <Link
                            key={href}
                            href={href}
                            className={`group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors ${isActive
                                ? 'bg-zinc-800/80 text-zinc-100'
                                : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                                }`}
                        >
                            <Icon
                                className={`h-4 w-4 shrink-0 ${isActive
                                    ? 'text-indigo-400'
                                    : 'text-zinc-600 group-hover:text-zinc-400'
                                    }`}
                            />
                            {label}
                        </Link>
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
