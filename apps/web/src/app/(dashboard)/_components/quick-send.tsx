// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'

export function QuickSend() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const [text, setText] = useState('')
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
    const [taskId, setTaskId] = useState<string | null>(null)

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        if (!text.trim() || status === 'sending') return

        setStatus('sending')
        try {
            const apiUrl = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
            const workspaceId = ctxWorkspaceId || process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE

            if (!workspaceId) throw new Error('No workspace found')

            const res = await fetch(`${apiUrl}/api/v1/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    type: 'automation',
                    source: 'dashboard',
                    context: { description: text.trim() },
                    priority: 5,
                }),
            })

            if (!res.ok) throw new Error('API error')
            const data = await res.json() as { id: string }
            setTaskId(data.id)
            setStatus('sent')
            setText('')
            setTimeout(() => setStatus('idle'), 4000)
        } catch {
            setStatus('error')
            setTimeout(() => setStatus('idle'), 3000)
        }
    }

    return (
        <div className="rounded-xl border border-border bg-surface-1/50 p-4 backdrop-blur-sm">
            <label
                htmlFor="quick-send-input"
                className="mb-2 block text-xs font-medium text-text-muted"
            >
                Quick task
            </label>
            <form onSubmit={handleSubmit} className="flex gap-2">
                <input
                    id="quick-send-input"
                    data-testid="quick-send-input"
                    type="text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Describe a task for your agent…"
                    className="flex-1 rounded-lg border border-border bg-canvas px-3 py-2.5 text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-indigo/50 focus:outline-none focus:ring-1 focus:ring-indigo/50 disabled:opacity-50 min-h-[44px]"
                    disabled={status === 'sending'}
                />
                <button
                    type="submit"
                    disabled={!text.trim() || status === 'sending'}
                    className="rounded-lg bg-indigo px-4 py-2.5 text-[16px] md:text-sm font-medium text-text-primary transition-all hover:bg-indigo/90 disabled:cursor-not-allowed disabled:opacity-40 min-h-[44px]"
                >
                    {status === 'sending' ? '…' : 'Send'}
                </button>
            </form>
            {status === 'sent' && taskId && (
                <p className="mt-2 text-[11px] text-emerald">
                    ✓ Task queued —{' '}
                    <Link href={`/tasks/${taskId}`} className="underline hover:text-emerald transition-colors">
                        view {taskId.slice(0, 8)}…
                    </Link>
                </p>
            )}
            {status === 'error' && (
                <p className="mt-2 text-[11px] text-red">
                    Failed to queue task. Make sure the API is running.
                </p>
            )}
            {status === 'idle' && !taskId && (
                <p className="mt-2 text-[11px] text-text-muted">
                    Tasks submitted here are processed by your agent automatically.
                </p>
            )}
        </div>
    )
}
