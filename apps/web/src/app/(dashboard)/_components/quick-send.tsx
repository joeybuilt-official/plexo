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
            const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
            const workspaceId = ctxWorkspaceId || process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE

            if (!workspaceId) throw new Error('No workspace found')

            const res = await fetch(`${apiUrl}/api/tasks`, {
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
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 backdrop-blur-sm">
            <label
                htmlFor="quick-send-input"
                className="mb-2 block text-xs font-medium text-zinc-500"
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
                    className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/50 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 disabled:opacity-50"
                    disabled={status === 'sending'}
                />
                <button
                    type="submit"
                    disabled={!text.trim() || status === 'sending'}
                    className="rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                    {status === 'sending' ? '…' : 'Send'}
                </button>
            </form>
            {status === 'sent' && taskId && (
                <p className="mt-2 text-[11px] text-emerald-500">
                    ✓ Task queued —{' '}
                    <Link href={`/tasks/${taskId}`} className="underline hover:text-emerald-400 transition-colors">
                        view {taskId.slice(0, 8)}…
                    </Link>
                </p>
            )}
            {status === 'error' && (
                <p className="mt-2 text-[11px] text-red-400">
                    Failed to queue task. Make sure the API is running.
                </p>
            )}
            {status === 'idle' && !taskId && (
                <p className="mt-2 text-[11px] text-zinc-600">
                    Tasks submitted here are processed by your agent automatically.
                </p>
            )}
        </div>
    )
}
