// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { usePathname } from 'next/navigation'
import { cn } from '@plexo/ui'

export function DashboardMain({ children }: { children: React.ReactNode }) {
    const pathname = usePathname()
    // For now, only /chat and maybe /insights (if it has a lot of data) should be full-bleed.
    // Actually, let's start with just /chat as requested.
    const isFullBleed = pathname === '/chat'

    return (
        <main 
            className={cn(
                "flex-1 relative z-0 hide-scrollbar",
                isFullBleed 
                    ? "overflow-hidden" // Child handles its own scroll (Chat / Workbench)
                    : "overflow-auto p-4 md:p-6 pb-[calc(72px+1rem+var(--safe-bottom))] md:pb-[calc(1.5rem+var(--safe-bottom))]"
            )}
            style={{
                '--safe-top': 'env(safe-area-inset-top)',
                '--safe-bottom': 'env(safe-area-inset-bottom)'
            } as React.CSSProperties}
        >
            {children}
        </main>
    )
}
