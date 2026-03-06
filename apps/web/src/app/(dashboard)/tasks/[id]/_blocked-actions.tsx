'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { RefreshCw, XCircle, ExternalLink, AlertTriangle, ArrowRight } from 'lucide-react'

// ── Root-cause resolution map ─────────────────────────────────────────────────
// Maps known outcome patterns to a fix destination and human-readable label.

const RESOLUTION_MAP: Array<{
    pattern: RegExp
    fixHref: string
    fixLabel: string
    fixDescription: string
}> = [
        {
            pattern: /no ai credential/i,
            fixHref: '/settings/ai-providers',
            fixLabel: 'Configure AI Provider',
            fixDescription: 'Add an API key so the agent can complete this task.',
        },
        {
            pattern: /rate limit/i,
            fixHref: '/settings/ai-providers',
            fixLabel: 'Check API Quotas',
            fixDescription: 'Your AI provider rate limit was hit. Review your plan or switch providers.',
        },
        {
            pattern: /no channel/i,
            fixHref: '/settings/connections',
            fixLabel: 'Add a Channel',
            fixDescription: 'Connect a channel so the agent can send and receive messages.',
        },
    ]

function resolveBlocker(outcomeSummary: string | null) {
    if (!outcomeSummary) return null
    return RESOLUTION_MAP.find(r => r.pattern.test(outcomeSummary)) ?? null
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BlockedActions({ taskId, outcomeSummary }: {
    taskId: string
    outcomeSummary: string | null
}) {
    const router = useRouter()
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

    const [retrying, setRetrying] = useState(false)
    const [dismissing, setDismissing] = useState(false)
    const [retried, setRetried] = useState(false)
    const [dismissed, setDismissed] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const resolution = resolveBlocker(outcomeSummary)

    async function handleRetry() {
        setRetrying(true)
        setError(null)
        try {
            const res = await fetch(`${apiBase}/api/v1/tasks/${taskId}/retry`, { method: 'POST' })
            if (!res.ok) {
                const body = await res.json() as { error?: { message?: string } }
                throw new Error(body.error?.message ?? 'Retry failed')
            }
            const { id: newId } = await res.json() as { id: string }
            setRetried(true)
            // Navigate to the new task after a brief moment
            setTimeout(() => router.push(`/tasks/${newId}`), 800)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setRetrying(false)
        }
    }

    async function handleDismiss() {
        setDismissing(true)
        setError(null)
        try {
            await fetch(`${apiBase}/api/v1/tasks/${taskId}`, { method: 'DELETE' })
            setDismissed(true)
            setTimeout(() => router.push('/'), 600)
        } catch {
            setError('Could not dismiss task.')
        } finally {
            setDismissing(false)
        }
    }

    if (retried) {
        return (
            <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/30 px-4 py-3 flex items-center gap-2 text-sm text-emerald-400">
                <RefreshCw className="h-4 w-4 animate-spin" />
                Task re-queued — redirecting…
            </div>
        )
    }

    if (dismissed) {
        return (
            <div className="rounded-xl border border-zinc-800/40 bg-zinc-900/30 px-4 py-3 text-sm text-zinc-500">
                Task dismissed.
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-red-900/40 bg-red-950/20 overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-2.5 border-b border-red-900/30 px-4 py-3">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                <div>
                    <p className="text-[13px] font-semibold text-red-300">This task is blocked</p>
                    <p className="text-[11px] text-red-500/70 mt-0.5">
                        {outcomeSummary ?? 'The agent could not continue. Choose an action below.'}
                    </p>
                </div>
            </div>

            {/* Actions */}
            <div className="flex flex-col divide-y divide-red-900/20">
                {/* Fix root cause — only shown when we know what to fix */}
                {resolution && (
                    <Link
                        href={resolution.fixHref}
                        className="group flex items-start gap-3 px-4 py-3.5 hover:bg-red-950/40 transition-colors"
                    >
                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-indigo-500/15 text-indigo-400 mt-0.5">
                            <ExternalLink className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-medium text-zinc-200 group-hover:text-white transition-colors">
                                {resolution.fixLabel}
                            </p>
                            <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                                {resolution.fixDescription}
                            </p>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-400 transition-colors mt-1" />
                    </Link>
                )}

                {/* Retry */}
                <button
                    onClick={() => void handleRetry()}
                    disabled={retrying || dismissing}
                    className="group flex items-start gap-3 px-4 py-3.5 hover:bg-red-950/40 transition-colors text-left disabled:opacity-40"
                >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-400 mt-0.5">
                        <RefreshCw className={`h-3.5 w-3.5 ${retrying ? 'animate-spin' : ''}`} />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-zinc-200 group-hover:text-white transition-colors">
                            {retrying ? 'Re-queuing…' : 'Retry task'}
                        </p>
                        <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
                            {resolution
                                ? 'After fixing the issue above, re-queue this task with the same parameters.'
                                : 'Re-queue this task with the same parameters.'}
                        </p>
                    </div>
                </button>

                {/* Dismiss */}
                <button
                    onClick={() => void handleDismiss()}
                    disabled={retrying || dismissing}
                    className="group flex items-start gap-3 px-4 py-3.5 hover:bg-red-950/40 transition-colors text-left disabled:opacity-40"
                >
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-500/15 text-zinc-500 mt-0.5">
                        <XCircle className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-zinc-400 group-hover:text-zinc-300 transition-colors">
                            {dismissing ? 'Dismissing…' : 'Dismiss'}
                        </p>
                        <p className="text-[11px] text-zinc-600 mt-0.5 leading-relaxed">
                            Cancel and clear this blocked task from your queue.
                        </p>
                    </div>
                </button>
            </div>

            {/* Inline error */}
            {error && (
                <div className="border-t border-red-900/30 px-4 py-2 text-[11px] text-red-400 bg-red-950/20">
                    {error}
                </div>
            )}
        </div>
    )
}
