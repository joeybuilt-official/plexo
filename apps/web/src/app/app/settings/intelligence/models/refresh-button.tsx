// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * RefreshButton — Phase 2b catalog browser admin control.
 *
 * Calls POST /api/v1/models/refresh which is gated by requireSuperAdmin
 * on the API. Non-admin users will see a 403 toast — that's the
 * server-side enforcement; the button stays visible because the web
 * layer doesn't know who's an admin.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw, Loader2 } from 'lucide-react'
import { refreshCatalog } from '@web/lib/intelligence-client'

interface RefreshButtonProps {
    onRefreshed?: () => void
}

export function RefreshButton({ onRefreshed }: RefreshButtonProps) {
    const [pending, setPending] = useState(false)

    async function handleClick() {
        if (pending) return
        setPending(true)
        try {
            await refreshCatalog()
            toast.success('Catalog refreshed')
            onRefreshed?.()
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Refresh failed')
        } finally {
            setPending(false)
        }
    }

    return (
        <button
            type="button"
            disabled={pending}
            onClick={() => void handleClick()}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary hover:border-azure disabled:opacity-50"
        >
            {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh catalog
        </button>
    )
}
