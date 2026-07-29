// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Generic Channel viewer — message view + send composer (ADR-0005).
 *
 * Plain-text only — markdown is not parsed (ADR-0005 §"Minimum scope (locked)").
 * No reactions UI, no edit indicators. Phase 4c renders the empty-state shell;
 * Phase 5 lands message ingestion + dispatch.
 *
 * Phone-offline banner copy locked by ADR-0005 §"Copy lock". Composer
 * placeholder is the locked "Type a message" string.
 */

'use client'

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { ArrowLeft, Loader2, Paperclip, Send } from 'lucide-react'
import { useWorkspaceId } from '@web/context/workspace'
import { API_BASE } from '@web/app/app/connections/_components/types'
import { PhoneOfflineBanner, type ConnectionState } from '../../_components/phone-offline-banner'

interface ChannelDetail {
    id: string
    type: string
    name: string
    state: ConnectionState
}

interface MessageRow {
    id: string
    direction: 'inbound' | 'outbound'
    text: string
    sentAt: string
    attachments?: Array<{ url: string; mimeType: string; filename?: string }>
    senderName?: string
    pending?: boolean
}

export default function ThreadMessagesPage() {
    const params = useParams<{ channelId: string; threadId: string }>()
    const channelId = params?.channelId
    const threadId = params?.threadId
    const workspaceId = useWorkspaceId()

    const [channel, setChannel] = useState<ChannelDetail | null>(null)
    const [messages, setMessages] = useState<MessageRow[]>([])
    const [loading, setLoading] = useState(true)
    const [notFound, setNotFound] = useState(false)

    const [draft, setDraft] = useState('')
    const [sending, setSending] = useState(false)
    const [sendError, setSendError] = useState<string | null>(null)

    const scrollRef = useRef<HTMLDivElement | null>(null)

    const load = useCallback(async (showLoading: boolean) => {
        if (!workspaceId || !channelId || !threadId) return
        if (showLoading) setLoading(true)
        try {
            const [chRes, msgRes] = await Promise.all([
                fetch(`${API_BASE}/api/v1/channels/${channelId}?workspaceId=${encodeURIComponent(workspaceId)}`, {
                    credentials: 'include',
                }),
                fetch(`${API_BASE}/api/v1/channels/${channelId}/threads/${threadId}/messages?workspaceId=${encodeURIComponent(workspaceId)}`, {
                    credentials: 'include',
                }),
            ])
            if (chRes.status === 404) {
                setNotFound(true)
                return
            }
            if (chRes.ok) setChannel(await chRes.json() as ChannelDetail)
            if (msgRes.ok) {
                const data = await msgRes.json() as { messages: MessageRow[] }
                setMessages(data.messages ?? [])
            }
        } finally {
            if (showLoading) setLoading(false)
        }
    }, [workspaceId, channelId, threadId])

    useEffect(() => { void load(true) }, [load])

    // Poll every 5s while the page is open + visible. Pauses when tab is
    // backgrounded so an idle tab doesn't burn API quota. Replaced by
    // `/api/plexo/channels/:channelId/events` SSE in Phase 6+.
    useEffect(() => {
        if (notFound) return
        const tick = () => {
            if (typeof document !== 'undefined' && document.hidden) return
            void load(false)
        }
        const id = setInterval(tick, 5000)
        return () => clearInterval(id)
    }, [load, notFound])

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
    }, [messages.length])

    const handleSend = useCallback(async () => {
        if (!draft.trim() || !workspaceId || !channelId || !threadId) return
        const text = draft.trim()
        setSending(true)
        setSendError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/channels/${channelId}/threads/${threadId}/messages`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, text }),
            })
            if (!res.ok) {
                const body = await res.json().catch(() => ({}))
                setSendError(body?.error?.message ?? 'Send failed')
                return
            }
            const sent = await res.json() as MessageRow
            setMessages((prev) => [...prev, { ...sent, direction: 'outbound', pending: true }])
            setDraft('')
        } catch (err) {
            setSendError(err instanceof Error ? err.message : 'Send failed')
        } finally {
            setSending(false)
        }
    }, [draft, workspaceId, channelId, threadId])

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
                <BackLink channelId={channelId ?? ''} />
                <p className="mt-6 text-sm text-text-muted">Channel not found.</p>
            </div>
        )
    }

    return (
        <div className="flex flex-1 flex-col p-6">
            <BackLink channelId={channelId ?? ''} />
            <header className="mb-3 mt-4">
                <h1 className="text-xl font-medium text-text-primary">{channel.name}</h1>
                <p className="mt-0.5 text-xs text-text-muted">Thread {threadId}</p>
            </header>

            <PhoneOfflineBanner state={channel.state} />

            <div
                ref={scrollRef}
                className="mt-4 flex flex-1 flex-col gap-2 overflow-y-auto rounded-md border border-border bg-bg-subtle p-4"
            >
                {messages.length === 0 ? (
                    <p className="self-center text-sm text-text-muted">No messages yet.</p>
                ) : (
                    messages.map((m) => <MessageBubble key={m.id} message={m} />)
                )}
            </div>

            <Composer
                value={draft}
                onChange={setDraft}
                onSend={handleSend}
                sending={sending}
                error={sendError}
            />
        </div>
    )
}

function BackLink({ channelId }: { channelId: string }) {
    return (
        <Link
            href={channelId ? `/app/channels/${channelId}` : '/app/channels'}
            className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary"
        >
            <ArrowLeft className="h-3 w-3" />
            Threads
        </Link>
    )
}

function MessageBubble({ message }: { message: MessageRow }) {
    const isOutbound = message.direction === 'outbound'
    return (
        <div className={`flex flex-col gap-1 ${isOutbound ? 'items-end' : 'items-start'}`}>
            <div
                className={`max-w-[80%] rounded-md px-3 py-2 text-sm ${isOutbound
                    ? 'bg-azure text-text-primary'
                    : 'bg-surface-2 text-text-primary'
                    }`}
            >
                {message.senderName && !isOutbound ? (
                    <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                        {message.senderName}
                    </div>
                ) : null}
                <p className="whitespace-pre-wrap break-words">{message.text}</p>
                {message.attachments?.length ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                        {message.attachments.map((a, i) => (
                            // Phase 5 wires attachment fetch + thumbnail rendering. Until then,
                            // a clickable file pill keeps the surface honest.
                            <a
                                key={`${message.id}-${i}`}
                                href={a.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 rounded bg-bg-subtle/30 px-2 py-1 text-[11px] text-text-primary"
                            >
                                <Paperclip className="h-3 w-3" />
                                {a.filename ?? a.mimeType}
                            </a>
                        ))}
                    </div>
                ) : null}
            </div>
            <span className="text-[10px] text-text-muted">
                {new Date(message.sentAt).toLocaleTimeString()}
                {message.pending ? ' · sending…' : null}
            </span>
        </div>
    )
}

function Composer({
    value, onChange, onSend, sending, error,
}: {
    value: string
    onChange: (v: string) => void
    onSend: () => void
    sending: boolean
    error: string | null
}) {
    return (
        <div className="mt-4 flex flex-col gap-2">
            {error ? (
                <p className="text-xs text-red">{error}</p>
            ) : null}
            <div className="flex items-end gap-2 rounded-md border border-border bg-surface-1 p-2">
                <textarea
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            onSend()
                        }
                    }}
                    placeholder="Type a message"
                    rows={2}
                    className="min-h-[44px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-text-primary placeholder:text-text-muted focus:outline-none"
                />
                <button
                    type="button"
                    onClick={onSend}
                    disabled={sending || !value.trim()}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-azure text-text-primary transition-colors hover:bg-azure/90 disabled:opacity-50"
                    aria-label="Send"
                >
                    {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
            </div>
        </div>
    )
}
