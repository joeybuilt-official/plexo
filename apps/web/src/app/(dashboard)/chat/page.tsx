'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import {
    Send,
    RefreshCw,
    Bot,
    User,
    Clock,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Loader2,
} from 'lucide-react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Message {
    id: string
    role: 'user' | 'agent'
    content: string
    taskId?: string
    status?: 'queued' | 'running' | 'complete' | 'failed' | 'pending'
    at: number
}

function fmt(ms: number): string {
    const s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
}

function StatusChip({ status }: { status: Message['status'] }) {
    if (!status || status === 'complete') return null
    const map = {
        queued: { icon: Clock, cls: 'text-zinc-500', label: 'Queued' },
        running: { icon: Loader2, cls: 'text-blue-400 animate-spin', label: 'Working…' },
        pending: { icon: Loader2, cls: 'text-zinc-500 animate-spin', label: 'Waiting…' },
        failed: { icon: XCircle, cls: 'text-red-400', label: 'Failed' },
    } as const
    const cfg = map[status as keyof typeof map]
    if (!cfg) return null
    const Icon = cfg.icon
    return (
        <span className={`inline-flex items-center gap-1 text-[11px] ${cfg.cls}`}>
            <Icon className="h-3 w-3" />
            {cfg.label}
        </span>
    )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ChatPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const [messages, setMessages] = useState<Message[]>([])
    const [input, setInput] = useState('')
    const [sending, setSending] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const bottomRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)
    const sessionId = useRef(`session-${Date.now()}`)

    // Scroll to bottom on new messages
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [messages])

    // Poll for pending agent replies
    const pollReply = useCallback(async (taskId: string, msgId: string) => {
        const deadline = Date.now() + 60_000
        const poll = async (): Promise<void> => {
            try {
                const res = await fetch(`${API}/api/chat/reply/${taskId}`)
                if (!res.ok) {
                    setMessages((prev) => prev.map((m) =>
                        m.id === msgId ? { ...m, status: 'failed', content: 'Failed to get response.' } : m
                    ))
                    return
                }
                const data = await res.json() as { status: string; reply: string | null }
                if (data.status === 'complete' || data.reply) {
                    setMessages((prev) => prev.map((m) =>
                        m.id === msgId ? { ...m, status: 'complete', content: data.reply ?? 'Done.' } : m
                    ))
                    return
                }
                if (Date.now() >= deadline) {
                    setMessages((prev) => prev.map((m) =>
                        m.id === msgId ? { ...m, status: 'pending', content: 'Agent is still working. Check back soon.' } : m
                    ))
                    return
                }
                // The backend long-polls up to 25s, so we just re-invoke after a brief gap
                await new Promise<void>((r) => setTimeout(r, 500))
                await poll()
            } catch {
                setMessages((prev) => prev.map((m) =>
                    m.id === msgId ? { ...m, status: 'failed', content: 'Connection error.' } : m
                ))
            }
        }
        await poll()
    }, [])

    async function sendMessage() {
        const text = input.trim()
        if (!text || sending) return
        if (!WS_ID) {
            setError('No workspace configured. Set NEXT_PUBLIC_DEFAULT_WORKSPACE in .env.local.')
            return
        }

        setInput('')
        setError(null)
        setSending(true)

        const userMsg: Message = {
            id: `u-${Date.now()}`,
            role: 'user',
            content: text,
            at: Date.now(),
        }

        const pendingId = `a-${Date.now()}`
        const pendingMsg: Message = {
            id: pendingId,
            role: 'agent',
            content: '',
            status: 'queued',
            at: Date.now(),
        }

        setMessages((prev) => [...prev, userMsg, pendingMsg])

        try {
            const res = await fetch(`${API}/api/chat/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, message: text, sessionId: sessionId.current }),
            })

            if (!res.ok) {
                const err = await res.json() as { error?: { message?: string } }
                setMessages((prev) => prev.map((m) =>
                    m.id === pendingId ? { ...m, status: 'failed', content: err.error?.message ?? 'Failed to send.' } : m
                ))
                return
            }

            const { taskId } = await res.json() as { taskId: string }
            setMessages((prev) => prev.map((m) =>
                m.id === pendingId ? { ...m, taskId, status: 'running' } : m
            ))

            await pollReply(taskId, pendingId)
        } catch {
            setMessages((prev) => prev.map((m) =>
                m.id === pendingId ? { ...m, status: 'failed', content: 'Network error.' } : m
            ))
        } finally {
            setSending(false)
            setTimeout(() => inputRef.current?.focus(), 50)
        }
    }

    function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void sendMessage()
        }
    }

    return (
        <div className="flex flex-col h-[calc(100vh-100px)]">
            {/* Header */}
            <div className="flex items-center justify-between pb-4 border-b border-zinc-800 shrink-0">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Chat</h1>
                    <p className="text-sm text-zinc-500 mt-0.5">Talk directly with your agent</p>
                </div>
                <div className="flex items-center gap-2">
                    {messages.length > 0 && (
                        <button
                            onClick={() => setMessages([])}
                            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                        >
                            Clear
                        </button>
                    )}
                    <Link
                        href="/conversations"
                        className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                    >
                        History →
                    </Link>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto py-4 flex flex-col gap-4 min-h-0">
                {messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
                        <div className="h-14 w-14 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                            <Bot className="h-7 w-7 text-white" />
                        </div>
                        <div>
                            <p className="text-base font-semibold text-zinc-300">Your agent is ready</p>
                            <p className="text-sm text-zinc-600 mt-1">Ask anything — debugging, code review, research, tasks.</p>
                        </div>
                        <div className="flex flex-wrap justify-center gap-2 max-w-md">
                            {[
                                'Summarize recent task activity',
                                'What tools do you have?',
                                'Review my last failed task',
                                'What is in my memory store?',
                            ].map((suggestion) => (
                                <button
                                    key={suggestion}
                                    onClick={() => { setInput(suggestion); inputRef.current?.focus() }}
                                    className="rounded-full border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:border-indigo-500/50 hover:text-zinc-200 transition-colors"
                                >
                                    {suggestion}
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {messages.map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
                    >
                        {/* Avatar */}
                        <div className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${msg.role === 'user'
                                ? 'bg-zinc-700'
                                : 'bg-gradient-to-br from-indigo-500 to-purple-600'
                            }`}>
                            {msg.role === 'user'
                                ? <User className="h-4 w-4 text-zinc-300" />
                                : <Bot className="h-4 w-4 text-white" />
                            }
                        </div>

                        {/* Bubble */}
                        <div className={`flex flex-col gap-1 max-w-[75%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                            <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${msg.role === 'user'
                                    ? 'bg-indigo-600 text-white rounded-tr-md'
                                    : msg.status === 'failed'
                                        ? 'bg-red-950/30 border border-red-800/40 text-red-300 rounded-tl-md'
                                        : 'bg-zinc-800 text-zinc-200 rounded-tl-md'
                                }`}>
                                {msg.status === 'queued' || msg.status === 'running' ? (
                                    <div className="flex items-center gap-2">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                                        <span className="text-zinc-500 text-sm italic">
                                            {msg.status === 'queued' ? 'Queued…' : 'Working…'}
                                        </span>
                                    </div>
                                ) : msg.status === 'failed' ? (
                                    <div className="flex items-center gap-1.5">
                                        <XCircle className="h-3.5 w-3.5 shrink-0" />
                                        {msg.content || 'Failed.'}
                                    </div>
                                ) : (
                                    <span className="whitespace-pre-wrap">{msg.content}</span>
                                )}
                            </div>

                            {/* Meta */}
                            <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                                <span>{fmt(msg.at)}</span>
                                {msg.taskId && (
                                    <Link
                                        href={`/tasks/${msg.taskId}`}
                                        className="hover:text-zinc-400 transition-colors font-mono"
                                    >
                                        {msg.taskId.slice(0, 8)} ↗
                                    </Link>
                                )}
                                {msg.status === 'complete' && (
                                    <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                                )}
                            </div>
                        </div>
                    </div>
                ))}
                <div ref={bottomRef} />
            </div>

            {/* Error banner */}
            {error && (
                <div className="shrink-0 flex items-center gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 text-sm text-red-400 mb-2">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    {error}
                </div>
            )}

            {/* Input */}
            <div className="shrink-0 flex gap-3 items-end pt-3 border-t border-zinc-800">
                <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Message your agent… (Enter to send, Shift+Enter for newline)"
                    rows={1}
                    disabled={sending}
                    className="flex-1 resize-none rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none disabled:opacity-50 max-h-32 leading-relaxed transition-colors"
                    style={{ minHeight: '48px' }}
                />
                <button
                    onClick={() => void sendMessage()}
                    disabled={sending || !input.trim()}
                    className="shrink-0 rounded-xl bg-indigo-600 p-3 text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    aria-label="Send"
                >
                    {sending
                        ? <RefreshCw className="h-4 w-4 animate-spin" />
                        : <Send className="h-4 w-4" />
                    }
                </button>
            </div>
        </div>
    )
}
