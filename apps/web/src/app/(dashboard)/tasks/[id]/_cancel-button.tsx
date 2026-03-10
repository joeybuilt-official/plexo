// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { XCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'

export function CancelButton({ taskId }: { taskId: string }) {
    const [cancelling, setCancelling] = useState(false)
    const [done, setDone] = useState(false)
    const router = useRouter()
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

    async function handleCancel() {
        if (!confirm('Cancel this task? The agent will stop after the current step.')) return
        setCancelling(true)
        try {
            await fetch(`${apiBase}/api/v1/tasks/${taskId}`, { method: 'DELETE' })
            setDone(true)
            router.refresh()
        } finally {
            setCancelling(false)
        }
    }

    if (done) return null

    return (
        <button
            onClick={() => void handleCancel()}
            disabled={cancelling}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:border-red-800/60 hover:text-red transition-colors disabled:opacity-40"
        >
            <XCircle className="h-3.5 w-3.5" />
            {cancelling ? 'Cancelling…' : 'Cancel task'}
        </button>
    )
}
