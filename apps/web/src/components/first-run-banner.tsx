// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * FirstRunBanner — Phase 6 of the intelligence overhaul.
 *
 * Non-dismissible banner shown across the dashboard when the active
 * workspace's `intelligence_settings.firstRunPending` flag is true.
 * Reads the same /detect endpoint the wizard uses so the banner can
 * surface a quick "X services up, Y configured" hint and link straight
 * to the wizard at /app/intelligence/wizard.
 *
 * The wizard's POST /wizard/complete handler flips the flag and busts
 * the cache, which causes the next /detect refetch to return
 * firstRunPending=false and the banner unmounts on its own.
 */

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Wand2, ArrowRight } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useDetect } from '@web/lib/intelligence-dashboard-client'

export function FirstRunBanner() {
    const { workspaceId } = useWorkspace()
    const pathname = usePathname()
    const { data } = useDetect(workspaceId || null)

    if (!workspaceId) return null
    // Don't nudge users into a wizard they're already standing in.
    if (pathname?.startsWith('/app/intelligence/wizard')) return null
    if (!data || !data.current.firstRunPending) return null

    const services = [
        data.services.postgres,
        data.services.pgvector,
        data.services.embeddings,
        data.services.ollama,
    ]
    const upCount = services.filter(s => s.status === 'up').length

    return (
        <div className="border-b border-azure/40 bg-surface-1 px-4 py-2">
            <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <Wand2 className="h-4 w-4 shrink-0 text-azure" />
                    <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-text-primary">
                            Finish setting up Plexo
                        </div>
                        <div className="truncate text-[11px] text-text-muted">
                            {upCount} of {services.length} services up · {data.providers.enabled} provider
                            {data.providers.enabled === 1 ? '' : 's'} enabled
                        </div>
                    </div>
                </div>
                <Link
                    href="/app/intelligence/wizard"
                    className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-azure bg-surface-1 px-2.5 py-1 text-[11px] text-azure ring-1 ring-azure/40 transition-colors hover:text-text-primary"
                >
                    Open wizard <ArrowRight className="h-3 w-3" />
                </Link>
            </div>
        </div>
    )
}
