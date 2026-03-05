'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, Activity } from 'lucide-react'
import { LiveDashboard } from './live-dashboard'

const STORAGE_KEY = 'plexo:system-health:collapsed'

export function SystemHealth() {
    const [collapsed, setCollapsed] = useState(() => {
        if (typeof window === 'undefined') return false
        try {
            return localStorage.getItem(STORAGE_KEY) === 'true'
        } catch {
            return false
        }
    })

    function toggle() {
        setCollapsed(prev => {
            const next = !prev
            try { localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* ignore */ }
            return next
        })
    }

    return (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-900/30 backdrop-blur-sm overflow-hidden">
            {/* Collapsible header */}
            <button
                onClick={toggle}
                className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-zinc-800/20"
            >
                <div className="flex items-center gap-2.5">
                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-zinc-600 to-zinc-700 text-zinc-300">
                        <Activity className="h-3 w-3" />
                    </div>
                    <h2 className="text-[13px] font-semibold text-zinc-400">System Health</h2>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-600">
                        {collapsed ? 'Show details' : 'Hide details'}
                    </span>
                    {collapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-zinc-600" />
                    ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-zinc-600" />
                    )}
                </div>
            </button>

            {/* Content */}
            {!collapsed && (
                <div className="border-t border-zinc-800/40 p-4">
                    <LiveDashboard />
                </div>
            )}
        </div>
    )
}
