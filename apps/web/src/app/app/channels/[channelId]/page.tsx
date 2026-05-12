// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Generic Channel viewer — thread list for one channel (ADR-0005). Most-
 * recent-first per ADR-0005 §"Minimum scope (locked)". Phase 4c renders the
 * empty-state shell; Phase 5 lands the aggregate query against `messages` +
 * `plexo_gmessages.message_dedupe`.
 *
 * Phone-offline banner at top sourced from `paired_sessions.state`. Copy is
 * locked per ADR-0005 §"Copy lock".
 */

'use client'

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, ChevronRight, Loader2, MessageSquare } from 'lucide-react'
import { useWorkspaceId } from '@web/context/workspace'
import { API_BASE } from '@web/app/app/connections/_components/types'
import { PhoneOfflineBanner, type ConnectionState } from '../_components/phone-offline-banner'

interface ChannelDetail {
    id: string
    type: string
    name: string
    state: ConnectionState
}

interface ThreadRow {
    id: string
    title: string
    lastMessagePreview: string | null
    lastMessageAt: string | null
    unreadCount: number
}

export default function ChannelThreadsPage() {
    const params = useParams<{ channelId: string }>()
    const channelId = params?.channelId
    const workspaceId = useWorkspaceId()
    const [channel, setChannel] = useState<ChannelDetail | null>(null)
    const [threads, setThreads] = useState<ThreadRow[]>([])
    const [loading, setLoading] = useState(true)
    const [notFound, setNotFound] = useState(false)

    const load = useCallback(async () => {
        if (!workspaceId || !channelId) return
        setLoading(true)
        try {
            const [chRes, thRes] = await Promise.all([
                fetch(`${API_BASE}/api/v1/channels/${channelId}?workspaceId=${encodeURIComponent(workspaceId)}`, {
                    credentials: 'include',
                }),
                fetch(`${API_BASE}/api/v1/channels/${channelId}/threads?workspaceId=${encodeURIComponent(workspaceId)}`, {
                    credentials: 'include',
                }),
            ])
            if (chRes.status === 404) {
                setNotFound(true)
                return
            }
            if (chRes.ok) setChannel(await chRes.json() as ChannelDetail)
            if (thRes.ok) {
                const data = await thRes.json() as { threads: ThreadRow[] }
                setThreads(data.threads ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [workspaceId, channelId])

    useEffect(() => { void load() }, [load])

    if (loading) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
        )
    }

    if (notFound || !channel) {
        return (
            <div className="flex flex-1 flex-col p-6">
                <BackLink />
                <p className="mt-6 text-sm text-text-muted">Channel not found.</p>
            </div>
        )
    }

    return (
        <div className="flex flex-1 flex-col p-6">
            <BackLink />
            <header className="mb-4 mt-4">
                <h1 className="text-2xl font-medium text-text-primary">{channel.name}</h1>
                <p className="mt-0.5 text-sm text-text-muted">{channel.type}</p>
            </header>

            <PhoneOfflineBanner state={channel.state} />

            {threads.length === 0 ? (
                <div className="mt-6 flex flex-col items-start gap-3 rounded-md border border-border bg-bg-subtle p-6">
                    <MessageSquare className="h-6 w-6 text-text-muted" />
                    <p className="text-sm font-medium text-text-primary">No messages yet.</p>
                    <p className="text-xs text-text-muted">
                        Threads will appear here once your phone delivers the first message.
                    </p>
                </div>
            ) : (
                <ul className="mt-4 flex flex-col gap-1.5">
                    {threads.map((t) => (
                        <li key={t.id}>
                            <Link
                                href={`/app/channels/${channelId}/${t.id}`}
                                className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-subtle px-4 py-3 transition-colors hover:border-text-muted"
                            >
                                <div className="flex min-w-0 flex-col gap-0.5">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium text-text-primary">{t.title}</span>
                                        {t.unreadCount > 0 ? (
                                            <span className="rounded-full bg-azure px-1.5 py-0.5 text-[10px] font-medium text-text-primary">
                                                {t.unreadCount}
                                            </span>
                                        ) : null}
                                    </div>
                                    {t.lastMessagePreview ? (
                                        <span className="truncate text-xs text-text-muted">{t.lastMessagePreview}</span>
                                    ) : null}
                                </div>
                                <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
                            </Link>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function BackLink() {
    return (
        <Link href="/app/channels" className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary">
            <ArrowLeft className="h-3 w-3" />
            Channels
        </Link>
    )
}
