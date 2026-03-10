// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
    RefreshCw, XCircle, ExternalLink, AlertTriangle, ArrowRight,
    Lightbulb, ChevronRight, CheckCircle2, Zap,
} from 'lucide-react'

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

// ── Clarification types ────────────────────────────────────────────────────────

interface ClarificationAlternative {
    label: string
    description: string
    taskDescription: string
}

interface ClarificationPayload {
    type: 'clarification'
    message: string
    alternatives: ClarificationAlternative[]
}

// ── Clarification panel ────────────────────────────────────────────────────────

function ClarificationPanel({ taskId, clarification }: {
    taskId: string
    clarification: ClarificationPayload
}) {
    const router = useRouter()
    const apiBase = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL ?? 'http://localhost:3001')
    const [choosing, setChoosing] = useState<number | null>(null)
    const [chosen, setChosen] = useState<number | null>(null)
    const [error, setError] = useState<string | null>(null)

    async function handleChoose(idx: number) {
        setChoosing(idx)
        setError(null)
        try {
            const res = await fetch(`${apiBase}/api/v1/tasks/${taskId}/clarification/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ alternativeIndex: idx }),
            })
            if (!res.ok) {
                const body = await res.json() as { error?: string }
                throw new Error(body.error ?? 'Failed to submit choice')
            }
            const { newTaskId } = await res.json() as { newTaskId: string }
            setChosen(idx)
            setTimeout(() => router.push(`/tasks/${newTaskId}`), 800)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setChoosing(null)
        }
    }

    if (chosen !== null) {
        return (
            <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/30 px-4 py-3 flex items-center gap-2 text-sm text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Alternative queued — redirecting to new task…
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-amber-900/40 bg-amber-950/10 overflow-hidden">
            {/* Header */}
            <div className="flex items-start gap-3 border-b border-amber-900/30 px-4 py-3.5">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/15 text-amber-400 mt-0.5">
                    <Lightbulb className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-amber-300">Capability gap detected</p>
                    <p className="text-[12px] text-amber-500/80 mt-0.5 leading-relaxed">{clarification.message}</p>
                </div>
            </div>

            {/* Alternatives */}
            <div className="px-4 py-3">
                <p className="text-[11px] text-zinc-500 mb-2 uppercase tracking-wide font-medium">Here's what I can do instead:</p>
                <div className="flex flex-col gap-2">
                    {clarification.alternatives.map((alt, idx) => (
                        <button
                            key={idx}
                            onClick={() => void handleChoose(idx)}
                            disabled={choosing !== null}
                            className="group flex items-center gap-3 rounded-lg border border-zinc-800/60 bg-zinc-900/60 px-3.5 py-3 text-left hover:bg-zinc-800/80 hover:border-zinc-700/60 transition-all disabled:opacity-50"
                        >
                            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-indigo-500/15 text-indigo-400">
                                {choosing === idx ? (
                                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Zap className="h-3.5 w-3.5" />
                                )}
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-[13px] font-medium text-zinc-200 group-hover:text-white transition-colors">
                                    {alt.label}
                                </p>
                                <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">{alt.description}</p>
                            </div>
                            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-400 transition-colors" />
                        </button>
                    ))}
                </div>
            </div>

            {error && (
                <div className="border-t border-amber-900/30 px-4 py-2 text-[11px] text-red-400 bg-red-950/20">
                    {error}
                </div>
            )}
        </div>
    )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function BlockedActions({ taskId, outcomeSummary, status = 'blocked' }: {
    taskId: string
    outcomeSummary: string | null
    status?: string
}) {
    const router = useRouter()
    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

    const [retrying, setRetrying] = useState(false)
    const [dismissing, setDismissing] = useState(false)
    const [retried, setRetried] = useState(false)
    const [dismissed, setDismissed] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [clarification, setClarification] = useState<ClarificationPayload | null>(null)
    const [clarificationLoading, setClarificationLoading] = useState(true)

    const resolution = resolveBlocker(outcomeSummary)

    // Try to fetch clarification payload if this is a capability-blocked task
    useEffect(() => {
        if (!taskId) return
        void (async () => {
            try {
                const res = await fetch(`${apiBase}/api/v1/tasks/${taskId}/clarification`)
                if (res.ok) {
                    const body = await res.json() as { clarification: ClarificationPayload }
                    setClarification(body.clarification)
                }
            } catch { /* non-fatal */ } finally {
                setClarificationLoading(false)
            }
        })()
    }, [taskId, apiBase])

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
        <div className="flex flex-col gap-3">
            {/* Clarification panel — shown when planner returned capability gap */}
            {!clarificationLoading && clarification && (
                <ClarificationPanel taskId={taskId} clarification={clarification} />
            )}

            {/* Standard blocked or failed panel */}
            <div className={`rounded-xl border overflow-hidden ${status === 'blocked' ? 'border-red-900/40 bg-red-950/20' : 'border-zinc-800/60 bg-zinc-900/30'}`}>
                {/* Header */}
                <div className={`flex items-center gap-2.5 border-b px-4 py-3 ${status === 'blocked' ? 'border-red-900/30' : 'border-zinc-800/40'}`}>
                    {status === 'blocked' ? (
                        <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                    ) : (
                        <XCircle className="h-4 w-4 shrink-0 text-zinc-500" />
                    )}
                    <div>
                        <p className={`text-[13px] font-semibold ${status === 'blocked' ? 'text-red-300' : 'text-zinc-300'}`}>
                            {status === 'blocked' ? 'This task is blocked' : 'This task was cancelled or failed'}
                        </p>
                        <p className={`text-[11px] mt-0.5 ${status === 'blocked' ? 'text-red-500/70' : 'text-zinc-500'}`}>
                            {outcomeSummary ?? 'The agent could not continue. Choose an action below.'}
                        </p>
                    </div>
                </div>

                {/* Actions */}
                <div className={`flex flex-col divide-y ${status === 'blocked' ? 'divide-red-900/20' : 'divide-zinc-800/40'}`}>
                    {/* Fix root cause — only shown when we know what to fix */}
                    {resolution && (
                        <Link
                            href={resolution.fixHref}
                            className={`group flex items-start gap-3 px-4 py-3.5 transition-colors ${status === 'blocked' ? 'hover:bg-red-950/40' : 'hover:bg-zinc-800/40'}`}
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

                    {/* Retry — hidden when clarification is shown (user should pick an alternative instead) */}
                    {!clarification && (
                        <button
                            onClick={() => void handleRetry()}
                            disabled={retrying || dismissing}
                            className={`group flex items-start gap-3 px-4 py-3.5 transition-colors text-left disabled:opacity-40 ${status === 'blocked' ? 'hover:bg-red-950/40' : 'hover:bg-zinc-800/40'}`}
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
                    )}

                    {/* Dismiss */}
                    <button
                        onClick={() => void handleDismiss()}
                        disabled={retrying || dismissing}
                        className={`group flex items-start gap-3 px-4 py-3.5 transition-colors text-left disabled:opacity-40 ${status === 'blocked' ? 'hover:bg-red-950/40' : 'hover:bg-zinc-800/40'}`}
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
                    <div className={`border-t px-4 py-2 text-[11px] ${status === 'blocked' ? 'border-red-900/30 text-red-400 bg-red-950/20' : 'border-zinc-800/40 text-rose-400 bg-rose-950/20'}`}>
                        {error}
                    </div>
                )}
            </div>
        </div>
    )
}
