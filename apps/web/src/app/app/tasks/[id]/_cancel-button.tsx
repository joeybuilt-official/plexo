// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { XCircle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useConfirm } from '@web/components/ui/confirm-dialog'

export function CancelButton({ taskId }: { taskId: string }) {
    const [cancelling, setCancelling] = useState(false)
    const [done, setDone] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const router = useRouter()
    const confirmAction = useConfirm()
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

    async function handleCancel() {
        if (!await confirmAction({ title: 'Cancel task', description: 'The agent will stop after the current step.', confirmLabel: 'Cancel task', variant: 'warning' })) return
        setCancelling(true)
        setError(null)
        try {
            const res = await fetch(`${apiBase}/api/v1/tasks/${taskId}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`Failed to cancel task (${res.status})`)
            setDone(true)
            router.refresh()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not cancel task')
        } finally {
            setCancelling(false)
        }
    }

    if (done) return null

    return (
        <div className="flex flex-col items-end gap-1">
            <button
                onClick={() => void handleCancel()}
                disabled={cancelling}
                className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-red-800/60 hover:text-red transition-colors disabled:opacity-40"
            >
                <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                {cancelling ? 'Cancelling…' : 'Cancel task'}
            </button>
            {error && (
                <p role="alert" className="text-[11px] text-red">{error}</p>
            )}
        </div>
    )
}
