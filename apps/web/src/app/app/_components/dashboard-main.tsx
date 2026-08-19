// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { usePathname } from 'next/navigation'
import { cn } from '@plexo/ui'
import { Breadcrumbs } from '@web/components/breadcrumbs'
import { ReadOnlyBanner } from './read-only-banner'

export function DashboardMain({ children }: { children: React.ReactNode }) {
    const pathname = usePathname()
    // For now, only /chat should be full-bleed.
    const isFullBleed = pathname === '/app/chat'

    return (
        <main
            id="main-content"
            className={cn(
                "flex-1 relative z-0",
                isFullBleed
                    ? "overflow-hidden" // Child handles its own scroll (Chat / Workbench)
                    : "overflow-auto p-4 md:p-6 pb-20 md:pb-6"
            )}
            style={{
                '--safe-top': 'env(safe-area-inset-top)',
                '--safe-bottom': 'env(safe-area-inset-bottom)'
            } as React.CSSProperties}
        >
            {!isFullBleed && <Breadcrumbs />}
            {!isFullBleed && <ReadOnlyBanner />}
            {children}
        </main>
    )
}
