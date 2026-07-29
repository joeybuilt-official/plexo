// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Activity, CheckSquare, MessageSquare, ShieldAlert, Settings } from 'lucide-react'

export function MobileShell({ children }: { children: React.ReactNode }) {
    const pathname = usePathname()
    const navItems = [
        { label: 'Home', href: '/app', icon: Activity },
        { label: 'Tasks', href: '/app/tasks', icon: CheckSquare },
        { label: 'Chat', href: '/app/chat', icon: MessageSquare },
        { label: 'Approvals', href: '/app/approvals', icon: ShieldAlert },
        { label: 'Settings', href: '/app/settings', icon: Settings },
    ]

    return (
        <div 
            className="flex flex-col h-[100dvh] overflow-hidden bg-canvas"
            style={{ paddingTop: 'env(safe-area-inset-top)' }}
        >
            {/* Main scrollable content area */}
            <main 
                className="flex-1 overflow-auto bg-canvas"
                style={{ paddingBottom: 'calc(4rem + env(safe-area-inset-bottom))' }}
            >
                {children}
            </main>

            {/* Bottom Navigation */}
            <nav 
                className="fixed bottom-0 left-0 right-0 bg-canvas border-t border-border/80 flex items-center justify-around px-2 z-50"
                style={{ 
                    height: 'calc(4rem + env(safe-area-inset-bottom))',
                    paddingBottom: 'env(safe-area-inset-bottom)'
                }}
            >
                {navItems.map((item) => {
                    const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href))
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${
                                active ? 'text-indigo' : 'text-text-muted hover:text-text-secondary'
                            }`}
                        >
                            <item.icon className="h-5 w-5" />
                            <span className="text-[10px] font-medium">{item.label}</span>
                        </Link>
                    )
                })}
            </nav>
        </div>
    )
}
