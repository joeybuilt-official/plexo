// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
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
    complete: { icon: CheckCircle, cls: 'text-emerald-400', label: 'Completed' },
    failed: { icon: XCircle, cls: 'text-red-400', label: 'Failed' },
    pending: { icon: Clock, cls: 'text-amber-400', label: 'Pending' },
}

export default function ConversationDetailPage() {
    const params = useParams()
    const id = params.id as string
    const { workspaceId } = useWorkspace()
    const [conv, setConv] = useState<Conversation | null>(null)
    const [loading, setLoading] = useState(true)
    const [notFound, setNotFound] = useState(false)

    useEffect(() => {
        if (!id) return
        fetch(`${API}/api/v1/conversations/${id}`)
            .then(r => {
                if (r.status === 404) { setNotFound(true); return null }
                return r.ok ? r.json() : null
            })
            .then(data => { if (data) setConv(data as Conversation) })
            .catch(() => {})
            .finally(() => setLoading(false))
    }, [id])

    if (loading) {
        return (
            <div className="flex items-center justify-center py-20 text-zinc-600">
                <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
        )
    }

    if (notFound || !conv) {
        return (
            <div className="max-w-2xl">
                <Link href="/conversations" className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-6">
                    <ArrowLeft className="h-4 w-4" /> Back to conversations
                </Link>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <p className="text-sm text-zinc-500">Conversation not found.</p>
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
        <div className="max-w-2xl flex flex-col gap-6">
            {/* Back nav */}
            <Link
                href="/conversations"
                className="inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
            >
                <ArrowLeft className="h-4 w-4" /> Back to conversations
            </Link>

            {/* Header card */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 flex flex-col gap-4">
                <div className="flex items-start justify-between gap-4">
                    <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[11px] text-zinc-500 font-mono">{conv.id}</span>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap mt-1">
                            <span className="text-xs bg-zinc-800 border border-zinc-700/50 rounded px-2 py-0.5 text-zinc-400">
                                {srcMeta.icon} {srcMeta.label}
                            </span>
                            {conv.intent && conv.intent !== 'CONVERSATION' && (
                                <span className="text-xs bg-indigo-900/40 border border-indigo-800/50 rounded px-2 py-0.5 text-indigo-400 capitalize">
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
                                href={`/tasks/${conv.taskId}`}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-600 transition-colors"
                            >
                                <ExternalLink className="h-3.5 w-3.5" />
                                View task
                            </Link>
                        )}
                        <Link
                            href={`/chat?context=${encodeURIComponent(conv.id)}`}
                            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
                        >
                            <MessageCircle className="h-3.5 w-3.5" />
                            Continue
                        </Link>
                    </div>
                </div>

                <p className="text-[11px] text-zinc-600">
                    {createdAt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                    {' · '}
                    {createdAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </p>
            </div>

            {/* Message thread */}
            <div className="flex flex-col gap-4">
                {/* User turn */}
                <div className="flex gap-3 flex-row-reverse">
                    <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-zinc-700">
                        <User className="h-4 w-4 text-zinc-300" />
                    </div>
                    <div className="flex flex-col gap-1 max-w-[85%] items-end">
                        <div className="rounded-2xl rounded-tr-md px-4 py-2.5 text-sm leading-relaxed bg-indigo-600 text-white">
                            {conv.message}
                        </div>
                    </div>
                </div>

                {/* Agent turn */}
                {body && (
                    <div className="flex gap-3">
                        <div className="shrink-0 h-8 w-8 rounded-full flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600">
                            <Bot className="h-4 w-4 text-white" />
                        </div>
                        <div className="flex flex-col gap-1 max-w-[85%] items-start">
                            <div className={`rounded-2xl rounded-tl-md px-4 py-2.5 text-sm leading-relaxed ${
                                conv.status === 'failed' && conv.errorMsg
                                    ? 'bg-red-950/30 border border-red-800/40 text-red-300'
                                    : 'bg-zinc-800 text-zinc-200'
                            }`}>
                                {body}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Meta footer */}
            {conv.sessionId && (
                <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/20 px-4 py-3">
                    <p className="text-[11px] text-zinc-600">
                        Session ID: <span className="font-mono text-zinc-500">{conv.sessionId}</span>
                    </p>
                </div>
            )}
        </div>
    )
}
