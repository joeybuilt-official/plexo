// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Generic Channel viewer — list of paired Channels (ADR-0005 §"Generic Channel
 * viewer (Plexo proper)"). Channel-type-agnostic: future Signal / WhatsApp
 * connectors render into the same surface with type='signal' etc.
 *
 * Phone-offline banner per row sourced from joined `paired_sessions.state`.
 * Phase 5 populates last-message preview + unread badge — until then rows
 * carry the locked "No messages yet." copy from ADR-0005 §"Copy lock".
 */

'use client'

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronRight, Loader2, MessageSquare } from 'lucide-react'
import { useWorkspaceId } from '@web/context/workspace'
import { EmptyState } from '@web/components/ui/empty-state'
import { PageError } from '@web/components/ui/page-error'
import { API_BASE } from '@web/app/app/connections/_components/types'

type ConnectionState = 'paired' | 'active' | 'refreshing' | 'expired' | 'revoked' | 'errored' | null

interface ChannelRow {
    id: string
    type: string
    name: string
    enabled: boolean
    lastMessageAt: string | null
    state: ConnectionState
}

const OFFLINE_STATES: ReadonlySet<ConnectionState> = new Set(['expired', 'revoked', 'errored'])

export default function ChannelsListPage() {
    const workspaceId = useWorkspaceId()
    const [items, setItems] = useState<ChannelRow[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    const load = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        setError(false)
        try {
            const res = await fetch(`${API_BASE}/api/v1/channels?workspaceId=${encodeURIComponent(workspaceId)}`, {
                credentials: 'include',
            })
            if (!res.ok) {
                setError(true)
                return
            }
            const data = await res.json() as { items: ChannelRow[] }
            setItems(data.items ?? [])
        } catch {
            setError(true)
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { void load() }, [load])

    if (loading) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
            </div>
        )
    }

    if (error) {
        return (
            <div className="flex flex-1 flex-col p-6">
                <PageError
                    message="Couldn't load channels"
                    detail="There was a problem reaching the server. Check your connection and try again."
                    onRetry={() => void load()}
                />
            </div>
        )
    }

    return (
        <div className="flex flex-1 flex-col p-6">
            <header className="mb-6">
                <h1 className="text-2xl font-medium text-text-primary">Channels</h1>
                <p className="mt-0.5 text-sm text-text-muted">Paired connections that produce messages.</p>
            </header>

            {items.length === 0 ? (
                <EmptyState
                    icon={MessageSquare}
                    headline="No channels yet"
                    description="Pair a connector that produces messages to see your threads here."
                    actionLabel="Pair your phone"
                    actionHref="/app/connections/gmessages/pair"
                />
            ) : (
                <ul className="flex flex-col gap-2">
                    {items.map((ch) => (
                        <li key={ch.id}>
                            <ChannelListRow ch={ch} />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}

function ChannelListRow({ ch }: { ch: ChannelRow }) {
    const offline = OFFLINE_STATES.has(ch.state)
    return (
        <Link
            href={`/app/channels/${ch.id}`}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-subtle px-4 py-3 transition-colors hover:border-text-muted"
        >
            <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 shrink-0 text-text-muted" />
                    <span className="truncate text-sm font-medium text-text-primary">{ch.name}</span>
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                        {ch.type}
                    </span>
                    {offline ? (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">
                            <AlertTriangle className="h-3 w-3" />
                            Offline
                        </span>
                    ) : null}
                </div>
                <span className="text-xs text-text-muted">No messages yet.</span>
            </div>
            <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
        </Link>
    )
}
