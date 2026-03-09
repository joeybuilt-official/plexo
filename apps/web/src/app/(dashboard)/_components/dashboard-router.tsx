// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"
import React, { useEffect, useState } from 'react'
import { getRuntimeContext } from '@plexo/ui/lib/runtime'
import { CommandCenter } from './command-center'
import { SystemHealth } from './system-health'
import { QuickSend } from './quick-send'
// We might need to import Recent Activity or Chat.
// Let's import the Chat component if possible, and Tasks component.

export function DashboardRouter({ defaultContent }: { defaultContent: React.ReactNode }) {
    const [runtime, setRuntime] = useState<'tauri' | 'capacitor' | 'browser' | null>(null)

    useEffect(() => {
        setRuntime(getRuntimeContext())
    }, [])

    if (runtime === null) {
        return <div className="animate-pulse">Loading dashboard...</div>
    }

    if (runtime === 'tauri') {
        // "Agent Status card + Chat side by side. Not the full dashboard grid."
        return (
            <div className="flex h-full flex-row gap-6">
                <div className="flex-1 overflow-auto">
                    <CommandCenter />
                </div>
                {/* Notice how the Chat is injected here. Since Chat is a server/client hybrid, we might just load it?
                Actually, we can't directly load ChatPage because it's an async component in Next.js Server Components. */}
            </div>
        )
    }

    if (runtime === 'capacitor') {
        // "Default view on open: Recent Activity feed. Not the dashboard grid."
        // We could just return the CommandCenter without the QuickSend and SystemHealth?
        // Or we could redirect to `/tasks`?
        // Wait, if MobileShell handles this, why not just `window.location.replace('/tasks')`?
        // But maybe they want it here.
    }

    return <>{defaultContent}</>
}
