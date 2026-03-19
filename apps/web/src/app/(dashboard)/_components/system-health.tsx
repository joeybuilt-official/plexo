// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

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
            try { localStorage.setItem(STORAGE_KEY, String(next)) } catch { /* localStorage unavailable in some contexts */ }
            return next
        })
    }

    return (
        <div className="rounded-xl border border-border/60 bg-surface-1/30 backdrop-blur-sm overflow-hidden">
            {/* Collapsible header */}
            <button
                onClick={toggle}
                className="flex w-full min-h-[44px] items-center justify-between px-4 py-3 transition-colors hover:bg-surface-2/20"
            >
                <div className="flex items-center gap-2.5">
                    <div className="flex h-6 w-6 items-center justify-center rounded-md   text-text-secondary">
                        <Activity className="h-3 w-3" />
                    </div>
                    <h2 className="text-[13px] font-semibold text-text-secondary">System Health</h2>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-[11px] text-text-muted">
                        {collapsed ? 'Show details' : 'Hide details'}
                    </span>
                    {collapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                    ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
                    )}
                </div>
            </button>

            {/* Content */}
            {!collapsed && (
                <div className="border-t border-border/40 p-4">
                    <LiveDashboard />
                </div>
            )}
        </div>
    )
}
