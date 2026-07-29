// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
    ArrowLeft,
    Bot,
    User,
    MessageCircle,
    ExternalLink,
    CheckCircle,
    XCircle,
    Clock,
    Loader2,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

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

const STATUS_CFG = {
    complete: { icon: CheckCircle, cls: 'text-azure', label: 'Completed' },
    failed: { icon: XCircle, cls: 'text-red', label: 'Failed' },
    pending: { icon: Clock, cls: 'text-amber', label: 'Pending' },
}

export default function ConversationDetailPage() {
    const params = useParams()
    const router = useRouter()
    const id = params.id as string
    const { workspaceId } = useWorkspace()
    const [conv, setConv] = useState<Conversation | null>(null)
    const [loading, setLoading] = useState(true)
    const [notFound, setNotFound] = useState(false)

    // UI-audit Phase 2: consolidate onto the session-grouped thread view
    // whenever the conversation has a sessionId. Single-message view is
    // the fallback for legacy rows without sessionId (imports, pre-session
    // telegram webhook data, etc.). Redirect fires right after the fetch
    // resolves so the "Loading…" flash is only visible on first nav.
    useEffect(() => {
        if (!id) return
        fetch(`${API}/api/v1/conversations/${id}`)
            .then(r => {
                if (r.status === 404) { setNotFound(true); return null }
                return r.ok ? r.json() : null
            })
            .then(data => {
                if (!data) return
                const c = data as Conversation
                if (c.sessionId) {
                    router.replace(`/app/conversations/thread?sessionId=${encodeURIComponent(c.sessionId)}`)
                    return
                }
                setConv(c)
            })
            .catch((err) => console.error('[conversations] fetch failed', err))
            .finally(() => setLoading(false))
    }, [id, router])

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20 text-text-muted">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
        )
    }

    if (notFound || !conv) {
        return (
            <div className="max-w-2xl">
                <Link href="/app/conversations" className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-secondary transition-colors mb-6">
                    <ArrowLeft className="h-4 w-4" /> Back to conversations
                </Link>
                <div className="rounded-sm border border-border bg-surface-1/40 py-16 text-center">
                    <p className="text-sm text-text-muted">Conversation not found.</p>
                </div>
            </div>
        )
    }

    const srcMeta = SOURCE_LABEL[conv.source] ?? { icon: '🖥', label: conv.source }
    const statusCfg = STATUS_CFG[conv.status] ?? STATUS_CFG.pending
    const StatusIcon = statusCfg.icon
    const createdAt = new Date(conv.createdAt)
    const body = conv.reply ?? conv.errorMsg ?? null

    return (
        <div className="max-w-2xl w-full min-w-0 flex flex-col gap-6 overflow-hidden">
            {/* Back nav */}
            <Link
                href="/app/conversations"
                className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-secondary transition-colors"
            >
                <ArrowLeft className="h-4 w-4" /> Back to conversations
            </Link>

            {/* Header card */}
            <div className="rounded-sm border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[11px] text-text-muted font-mono">{conv.id}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap mt-1">
                            <span className="text-xs bg-surface-2 border border-border/50 rounded px-2 py-0.5 text-text-secondary">
                                {srcMeta.icon} {srcMeta.label}
                            </span>
                            {conv.intent && conv.intent !== 'CONVERSATION' && (
                                <span className="text-xs bg-azure-900/40 border border-azure-800/50 rounded px-2 py-0.5 text-azure capitalize">
                                    {conv.intent.toLowerCase()}
                                </span>
                            )}
                            <span className={`flex items-center gap-1 text-xs ${statusCfg.cls}`}>
                                <StatusIcon className="h-3.5 w-3.5" />
                                {statusCfg.label}
                            </span>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        {conv.taskId && (
                            <Link
                                href={`/app/tasks/${conv.taskId}`}
                                className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface-2/60 px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary hover:border-border transition-colors"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                View task
                            </Link>
                        )}
                        <Link
                            href={`/app/chat?context=${encodeURIComponent(conv.id)}`}
                            className="inline-flex items-center gap-1.5 rounded-sm bg-azure px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors"
                        >
                            <MessageCircle className="h-3.5 w-3.5" />
                            Continue
                        </Link>
                    </div>
                </div>

                <p className="text-[11px] text-text-muted">
                    {createdAt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                    {' · '}
                    {createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </p>
            </div>

            {/* Message thread */}
            <div className="flex flex-col gap-4">
                {/* User turn */}
                <div className="flex gap-3 flex-row-reverse">
                    <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-surface-2">
                        <User className="h-4 w-4 text-text-secondary" />
                    </div>
                    <div className="flex flex-col gap-1 max-w-[85%] min-w-0 items-end">
                        <div className="rounded-sm rounded-tr-md px-4 py-2.5 text-sm leading-relaxed bg-azure text-text-primary break-words overflow-hidden whitespace-pre-wrap">
                            {conv.message}
                        </div>
                    </div>
                </div>

                {/* Agent turn */}
                {body && (
                    <div className="flex gap-3">
                        <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center  ">
                            <Bot className="h-4 w-4 text-text-primary" />
                        </div>
                        <div className="flex flex-col gap-1 max-w-[85%] min-w-0 items-start">
                            <div className={`rounded-sm rounded-tl-md px-4 py-2.5 text-sm leading-relaxed break-words overflow-hidden whitespace-pre-wrap ${
                                conv.status === 'failed' && conv.errorMsg
                                    ? 'bg-red-dim border border-red-800/40 text-red-300'
                                    : 'bg-surface-2 text-text-primary'
                            }`}>
                                {body}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Meta footer */}
            {conv.sessionId && (
                <div className="rounded-sm border border-border/60 bg-surface-1/20 px-4 py-3">
                    <p className="text-[11px] text-text-muted">
                        Session ID: <span className="font-mono text-text-muted">{conv.sessionId}</span>
                    </p>
                </div>
            )}
        </div>
    )
}
