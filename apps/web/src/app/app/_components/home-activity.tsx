// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { useWorkspaceId } from '@web/context/workspace'
import Link from 'next/link'
import {
    CheckCircle2, Loader2, AlertCircle, Clock,
    MessageSquare, ArrowRight,
} from 'lucide-react'

interface TaskItem {
    id: string
    type: string
    description?: string
    outcomeSummary?: string
    status: string
    createdAt: string
}

interface ConversationItem {
    sessionId: string
    source: string
    message: string
    reply?: string
    createdAt: string
    turn_count?: number
}

interface DashboardSummary {
    running: number
    queued: number
    completed7d: number
    blocked: number
}

function timeAgo(date: string): string {
    const ms = Date.now() - new Date(date).getTime()
    if (ms < 60_000) return 'just now'
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
    return `${Math.floor(ms / 86_400_000)}d ago`
}

function StatusIcon({ status }: { status: string }) {
    if (status === 'complete') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    if (status === 'running') return <Loader2 className="h-3.5 w-3.5 text-azure animate-spin" />
    if (status === 'failed' || status === 'blocked') return <AlertCircle className="h-3.5 w-3.5 text-red" />
    return <Clock className="h-3.5 w-3.5 text-text-muted" />
}

export function HomeActivity() {
    const WS_ID = useWorkspaceId()
    const [summary, setSummary] = useState<DashboardSummary | null>(null)
    const [activity, setActivity] = useState<TaskItem[]>([])
    const [conversations, setConversations] = useState<ConversationItem[]>([])
    const [loading, setLoading] = useState(true)
    const [fetchError, setFetchError] = useState(false)
    const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

    const load = useCallback(async () => {
        if (!WS_ID) { setLoading(false); return }
        setFetchError(false)
        try {
            const [sumRes, actRes, convRes] = await Promise.all([
                fetch(`${API_BASE}/api/v1/dashboard/summary?workspaceId=${WS_ID}`),
                fetch(`${API_BASE}/api/v1/dashboard/activity?workspaceId=${WS_ID}&limit=5`),
                fetch(`${API_BASE}/api/v1/conversations?workspaceId=${WS_ID}&limit=5`),
            ])
            if (sumRes.ok) setSummary(await sumRes.json())
            if (actRes.ok) {
                const d = await actRes.json()
                setActivity((d.items ?? d.activity ?? []).slice(0, 5))
            }
            if (convRes.ok) {
                const d = await convRes.json()
                setConversations((d.items ?? d.conversations ?? []).slice(0, 5))
            }
            if (!sumRes.ok && !actRes.ok && !convRes.ok) setFetchError(true)
        } catch { setFetchError(true) }
        finally { setLoading(false) }
    }, [WS_ID, API_BASE])

    useEffect(() => { void load() }, [load])

    if (loading) {
        return (
            <div className="w-full max-w-3xl mx-auto mt-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="rounded-xl border border-border/40 bg-surface-1/20 p-4 h-32 animate-pulse" />
                    <div className="rounded-xl border border-border/40 bg-surface-1/20 p-4 h-32 animate-pulse" />
                </div>
            </div>
        )
    }

    if (fetchError) {
        return (
            <div className="w-full max-w-3xl mx-auto mt-2">
                <div className="rounded-lg border border-red-900/40 bg-red-900/10 px-3 py-2.5 text-sm text-red-300 text-center" role="alert">
                    Could not load dashboard activity.{' '}
                    <button onClick={() => { setLoading(true); void load() }} className="underline hover:no-underline">Retry</button>
                </div>
            </div>
        )
    }

    if (!summary && activity.length === 0 && conversations.length === 0) return null

    const hasActivity = summary && (summary.running > 0 || summary.queued > 0 || activity.length > 0)
    const hasConversations = conversations.length > 0

    if (!hasActivity && !hasConversations) return null

    return (
        <div className="w-full max-w-3xl mx-auto space-y-6 mt-2">
            {/* Live status bar */}
            {summary && (summary.running > 0 || summary.queued > 0) && (
                <div className="flex items-center justify-center gap-4 rounded-xl border border-azure/20 bg-azure/5 px-4 py-2.5">
                    {summary.running > 0 && (
                        <div className="flex items-center gap-1.5 text-xs">
                            <Loader2 className="h-3 w-3 text-azure animate-spin" />
                            <span className="text-azure font-medium">{summary.running} running</span>
                        </div>
                    )}
                    {summary.queued > 0 && (
                        <div className="flex items-center gap-1.5 text-xs">
                            <Clock className="h-3 w-3 text-text-muted" />
                            <span className="text-text-muted">{summary.queued} queued</span>
                        </div>
                    )}
                    <Link href="/app/tasks" className="text-[11px] text-azure hover:text-azure/80 transition-colors ml-auto">
                        View all <ArrowRight className="h-2.5 w-2.5 inline" />
                    </Link>
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Recent activity */}
                {activity.length > 0 && (
                    <div className="rounded-xl border border-border/40 bg-surface-1/20 p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Recent Work</h3>
                            <Link href="/app/tasks" className="text-[11px] text-azure hover:text-azure/80 transition-colors">
                                View all
                            </Link>
                        </div>
                        <div className="space-y-2">
                            {activity.map(t => (
                                <Link key={t.id} href={`/app/tasks/${t.id}`}
                                    className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2/30 transition-colors group">
                                    <StatusIcon status={t.status} />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs text-text-primary truncate group-hover:text-azure transition-colors">
                                            {t.outcomeSummary || t.description || t.type}
                                        </p>
                                        <p className="text-[11px] text-text-muted">{timeAgo(t.createdAt)}</p>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}

                {/* Recent conversations */}
                {hasConversations && (
                    <div className="rounded-xl border border-border/40 bg-surface-1/20 p-4">
                        <div className="flex items-center justify-between mb-3">
                            <h3 className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Recent Conversations</h3>
                            <Link href="/app/conversations" className="text-[11px] text-azure hover:text-azure/80 transition-colors">
                                View all
                            </Link>
                        </div>
                        <div className="space-y-2">
                            {conversations.map((c, i) => (
                                <Link key={c.sessionId + i}
                                    href={`/app/chat?sessionId=${encodeURIComponent(c.sessionId)}`}
                                    className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2/30 transition-colors group">
                                    <MessageSquare className="h-3.5 w-3.5 text-text-muted shrink-0 mt-0.5" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs text-text-primary truncate group-hover:text-azure transition-colors">
                                            {c.message.slice(0, 80)}{c.message.length > 80 ? '...' : ''}
                                        </p>
                                        <p className="text-[11px] text-text-muted">
                                            {c.source} &middot; {timeAgo(c.createdAt)}
                                            {c.turn_count && c.turn_count > 1 ? ` · ${c.turn_count} turns` : ''}
                                        </p>
                                    </div>
                                </Link>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
