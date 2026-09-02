// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
    ArrowLeft,
    Bot,
    User,
    MessageCircle,
    Loader2,
    Layers,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { PlexoAwarenessBadge } from '@web/components/plexo-awareness-badge'

const API = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

interface Conversation {
    id: string
    workspaceId: string
    sessionId: string | null
    source: string
    message: string
    reply: string | null
    errorMsg: string | null
    status: 'pending' | 'complete' | 'failed'
    intent: string | null
    taskId: string | null
    createdAt: string
}

const SOURCE_LABEL: Record<string, { icon: string; label: string }> = {
    telegram: { icon: '✈️', label: 'Telegram' },
    slack: { icon: '⚡', label: 'Slack' },
    discord: { icon: '💬', label: 'Discord' },
    github: { icon: '🐙', label: 'GitHub' },
    dashboard: { icon: '🖥', label: 'Dashboard' },
    api: { icon: '🔗', label: 'API' },
    widget: { icon: '💬', label: 'Widget' },
}

// ── Single turn view ──────────────────────────────────────────────────────────

function TurnBubble({ conv }: { conv: Conversation }) {
    const body = conv.reply ?? conv.errorMsg ?? null
    const isFailed = conv.status === 'failed' && !!conv.errorMsg

    return (
        <div className="flex flex-col gap-3">
            {/* User message */}
            <div className="flex gap-3 flex-row-reverse">
                <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-surface-2">
                    <User className="h-4 w-4 text-text-secondary" />
                </div>
                <div className="flex flex-col gap-1 max-w-[85%] min-w-0 items-end">
                    <div className="rounded-sm rounded-tr-md px-4 py-2.5 text-sm leading-relaxed bg-azure text-text-primary break-words overflow-hidden whitespace-pre-wrap">
                        {conv.message}
                    </div>
                    <span className="text-[11px] text-text-muted">
                        {new Date(conv.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                </div>
            </div>

            {/* Agent reply */}
            {body && (
                <div className="flex gap-3">
                    <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center  ">
                        <Bot className="h-4 w-4 text-text-primary" />
                    </div>
                    <div className="flex flex-col gap-1 max-w-[85%] min-w-0 items-start">
                        <div className={`rounded-sm rounded-tl-md px-4 py-2.5 text-sm leading-relaxed break-words overflow-hidden whitespace-pre-wrap ${
                            isFailed
                                ? 'bg-red-dim border border-red-800/40 text-red-300'
                                : 'bg-surface-2 text-text-primary'
                        }`}>
                            {body}
                        </div>
                        {!isFailed && <PlexoAwarenessBadge action="Plexo" compact />}
                    </div>
                </div>
            )}
        </div>
    )
}

// ── Session thread view ───────────────────────────────────────────────────────

function ThreadView({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) {
    const [turns, setTurns] = useState<Conversation[]>([])
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        fetch(`${API}/api/v1/conversations?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}&limit=100`)
            .then(r => r.ok ? r.json() as Promise<{ items: Conversation[] }> : null)
            .then(data => { if (data) setTurns(data.items) })
            .catch((err) => console.error('[conversations/thread] fetch failed', err))
            .finally(() => setLoading(false))
    }, [sessionId, workspaceId])

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20 text-text-muted">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading thread…
            </div>
        )
    }

    if (turns.length === 0) {
        return (
            <div className="rounded-sm border border-border bg-surface-1/40 p-12 text-center">
                <MessageCircle className="h-10 w-10 text-text-muted mx-auto mb-3" />
                <p className="text-sm font-medium text-text-secondary">No turns found</p>
                <p className="text-xs text-text-muted mt-1">This session has no recorded messages.</p>
            </div>
        )
    }

    const firstTurn = turns[0]!
    const lastTurn = turns[turns.length - 1]!
    const srcMeta = SOURCE_LABEL[firstTurn.source] ?? { icon: '🖥', label: firstTurn.source }
    const linkedTaskId = turns.find(t => t.taskId)?.taskId ?? null

    return (
        <div className="max-w-2xl w-full min-w-0 flex flex-col gap-6 overflow-hidden">
            {/* Back */}
            <Link href="/app/conversations" className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-secondary transition-colors">
                <ArrowLeft className="h-4 w-4" /> Back to conversations
            </Link>

            {/* Header */}
            <div className="rounded-sm border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs bg-surface-2 border border-border/50 rounded px-2 py-0.5 text-text-secondary">
                                {srcMeta.icon} {srcMeta.label}
                            </span>
                            <span className="flex items-center gap-1 text-xs bg-surface-2 border border-border/50 rounded px-2 py-0.5 text-text-muted">
                                <Layers className="h-3 w-3" /> {turns.length} turn{turns.length === 1 ? '' : 's'}
                            </span>
                        </div>
                        <p className="text-[11px] text-text-muted">
                            {new Date(firstTurn.createdAt).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                            {' · '}
                            {new Date(firstTurn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {' – '}
                            {new Date(lastTurn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {linkedTaskId && (
                            <Link
                                href={`/app/tasks/${linkedTaskId}`}
                                className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-2/60 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:border-border transition-colors"
                            >
                                View task
                            </Link>
                        )}
                        <Link
                            href={`/app/chat?sessionId=${encodeURIComponent(sessionId)}`}
                            className="inline-flex items-center gap-1.5 rounded-sm bg-azure px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors"
                        >
                            <MessageCircle className="h-3.5 w-3.5" />
                            Continue
                        </Link>
                    </div>
                </div>
                <p className="text-[11px] font-mono text-text-muted truncate">{sessionId}</p>
            </div>

            {/* Thread */}
            <div className="flex flex-col gap-6 min-w-0">
                {turns.map((turn, i) => (
                    <div key={turn.id} className={`${i > 0 ? 'border-t border-border/60 pt-6' : ''}`}>
                        <TurnBubble conv={turn} />
                    </div>
                ))}
            </div>
        </div>
    )
}

// ── Single conversation view (fallback when no sessionId) ─────────────────────

function SingleView() {
    // This component is the fallback shown when ?sessionId= is not present
    // but the page is loaded with a conversationId from the search param (shouldn't
    // normally happen from the list, but keeps the direct-link case working).
    const params = useSearchParams()
    const rawSessionId = params.get('sessionId')
    const { workspaceId } = useWorkspace()

    if (rawSessionId && workspaceId) {
        return <ThreadView sessionId={rawSessionId} workspaceId={workspaceId} />
    }

    return (
        <div className="flex items-center justify-center py-20 text-text-muted">
            <p className="text-sm">No session selected.</p>
        </div>
    )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ConversationsThreadPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center py-20 text-text-muted">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
        }>
            <SingleView />
        </Suspense>
    )
}
