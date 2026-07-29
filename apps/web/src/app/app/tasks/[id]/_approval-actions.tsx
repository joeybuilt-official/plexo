// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { CheckCircle2, XCircle, Loader2, ShieldAlert } from 'lucide-react'

// Phase 5 — task UI surface for the OWD/awaiting_approval pipeline. Renders a
// CONFIRM / CANCEL pair that POSTs to /api/v1/tasks/:id/{confirm,cancel}.
// `confirmationCode` is the first 6 hex of the OWD approval id (mirrored from
// what's shown in the chat-channel notification) so the user can cross-check.

export function ApprovalActions({
    taskId,
    confirmationCode,
    description,
}: {
    taskId: string
    confirmationCode: string | null
    description: string | null
}) {
    const router = useRouter()
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
    const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null)
    const [done, setDone] = useState<'confirm' | 'cancel' | null>(null)
    const [error, setError] = useState<string | null>(null)

    async function act(kind: 'confirm' | 'cancel') {
        setBusy(kind)
        setError(null)
        try {
            const res = await fetch(`${apiBase}/api/v1/tasks/${taskId}/${kind}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({})) as { error?: { message?: string } }
                throw new Error(body.error?.message ?? `Request failed (${res.status})`)
            }
            setDone(kind)
            // Brief delay so the user sees the success state before refresh swaps it out.
            setTimeout(() => router.refresh(), 600)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setBusy(null)
        }
    }

    if (done === 'confirm') {
        return (
            <div role="status" aria-live="polite" className="rounded-sm border border-azure-800/40 bg-azure/30 px-4 py-3 flex items-center gap-2 text-sm text-azure">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                Confirmed — agent resuming…
            </div>
        )
    }
    if (done === 'cancel') {
        return (
            <div role="status" aria-live="polite" className="rounded-sm border border-border/40 bg-surface-1/30 px-4 py-3 text-sm text-text-muted">
                Task cancelled.
            </div>
        )
    }

    return (
        <div className="rounded-sm border border-amber-900/40 bg-amber-dim/10 overflow-hidden">
            <div className="flex items-start gap-3 border-b border-amber-900/30 px-4 py-3.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber/15 text-amber mt-0.5">
                    <ShieldAlert className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium text-amber-300">Awaiting your confirmation</p>
                    <p className="text-[12px] text-amber/80 mt-0.5 leading-relaxed">
                        {description ?? 'The agent has reached a step that needs your approval before continuing.'}
                    </p>
                    {confirmationCode && (
                        <p className="text-[11px] text-text-muted mt-1.5 font-mono">
                            Code: <span className="text-text-secondary tracking-wider">{confirmationCode}</span>
                        </p>
                    )}
                </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 bg-surface-1/40">
                <button
                    onClick={() => void act('cancel')}
                    disabled={busy !== null}
                    className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-text-secondary hover:border-red-800/60 hover:text-red transition-colors disabled:opacity-40"
                >
                    {busy === 'cancel' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <XCircle className="h-3.5 w-3.5" aria-hidden="true" />}
                    Cancel
                </button>
                <button
                    onClick={() => void act('confirm')}
                    disabled={busy !== null}
                    className="flex items-center gap-1.5 rounded-sm bg-azure px-3 py-1.5 text-sm font-medium text-white hover:bg-azure/90 transition-colors disabled:opacity-50"
                >
                    {busy === 'confirm' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}
                    Confirm
                </button>
            </div>

            {error && (
                <p role="alert" className="border-t border-amber-900/30 px-4 py-2 text-[11px] text-red bg-red-dim">
                    {error}
                </p>
            )}
        </div>
    )
}
