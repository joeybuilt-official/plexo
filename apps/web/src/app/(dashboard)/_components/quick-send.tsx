// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { useWorkspace } from '@web/context/workspace'
import { Code2, Search, Server, BarChart2, Send, RefreshCw, PenLine, Plus, ArrowRight } from 'lucide-react'

export function QuickSend() {
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const [text, setText] = useState('')
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
    const [taskId, setTaskId] = useState<string | null>(null)
    const inputRef = useRef<HTMLTextAreaElement>(null)

    async function handleSubmit(e?: React.FormEvent | React.MouseEvent) {
        e?.preventDefault()
        if (!text.trim() || status === 'sending') return

        setStatus('sending')
        try {
            const apiUrl = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
            const workspaceId = ctxWorkspaceId || process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE

            if (!workspaceId) throw new Error('No workspace found')

            const res = await fetch(`${apiUrl}/api/v1/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    type: 'automation',
                    source: 'dashboard',
                    context: { description: text.trim() },
                    priority: 5,
                }),
            })

            if (!res.ok) throw new Error('API error')
            const data = await res.json() as { id: string }
            setTaskId(data.id)
            setStatus('sent')
            setText('')
            setTimeout(() => setStatus('idle'), 4000)
        } catch {
            setStatus('error')
            setTimeout(() => setStatus('idle'), 3000)
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            handleSubmit()
        }
    }

    return (
        <div className="w-full mx-auto flex flex-col gap-6 animate-in fade-in duration-700 delay-150 fill-mode-both">
            {/* Main Input Box */}
            <div className="relative flex flex-col gap-2 p-1.5 rounded-[24px] border border-border bg-surface-1/50 backdrop-blur-sm shadow-[0_2px_24px_-12px_rgba(0,0,0,0.5)] transition-all focus-within:ring-2 focus-within:ring-azure/20 focus-within:border-azure/50">
                <textarea
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Message your agent to start a task..."
                    className="flex-1 resize-none bg-transparent px-4 py-3 text-[16px] md:text-[15px] text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50 min-h-[64px] leading-relaxed"
                    disabled={status === 'sending'}
                    rows={2}
                />
                <div className="flex items-center justify-between px-2 pb-1.5">
                    <div className="flex gap-2 text-xs text-text-muted">
                        {status === 'sent' && taskId && (
                            <Link href={`/tasks/${taskId}`} className="flex items-center gap-1.5 text-azure hover:text-azure-400 transition-colors bg-azure/10 px-2.5 py-1.5 rounded-lg border border-azure/20 font-medium tracking-wide">
                                <span>✓ Task queued</span>
                                <span>View task →</span>
                            </Link>
                        )}
                        {status === 'error' && (
                            <span className="text-red-400 bg-red-950/30 px-2.5 py-1.5 rounded-lg border border-red-900/50 flex items-center gap-1.5 font-medium">
                                Failed. Is the API running?
                            </span>
                        )}
                    </div>
                    <button
                        onClick={handleSubmit}
                        disabled={!text.trim() || status === 'sending'}
                        className="flex shrink-0 items-center justify-center min-h-[36px] min-w-[36px] rounded-xl bg-text-primary text-canvas hover:bg-text-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
                        aria-label="Send Task"
                    >
                        {status === 'sending' 
                            ? <RefreshCw className="h-4 w-4 animate-spin text-canvas" /> 
                            : <Send className="h-4 w-4 text-[var(--canvas)]" style={{ transform: 'translateX(-1px) translateY(1px)' }} />
                        }
                    </button>
                </div>
            </div>

            {/* Prompt Chips */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 w-full px-1">
                {[
                    { icon: Code2, label: 'Code', desc: 'Build or modify features', prompt: 'Write a React component that...' },
                    { icon: Search, label: 'Research', desc: 'Synthesize information', prompt: 'Research the latest developments in...' },
                    { icon: Server, label: 'Ops', desc: 'Infrastructure & deployment', prompt: 'Audit all production servers for...' },
                    { icon: BarChart2, label: 'Data', desc: 'Query and analyze', prompt: 'Identify all users who converted...' },
                    { icon: PenLine, label: 'Writing', desc: 'Draft and generate content', prompt: 'Write a technical blog post explaining...' },
                ].map((item) => {
                    const Icon = item.icon
                    return (
                        <button
                            key={item.label}
                            onClick={() => { 
                                setText(item.prompt)
                                setTimeout(() => inputRef.current?.focus(), 10)
                            }}
                            className="group flex flex-col items-start gap-1.5 rounded-2xl border border-zinc-700/40 bg-surface-1/40 px-4 py-3.5 text-left transition-all duration-300 hover:border-azure/40 hover:bg-surface-2/60 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_-12px_rgba(99,102,241,0.2)]"
                        >
                            <div className="flex items-center gap-2.5 mb-0.5">
                                <div className="rounded-lg bg-zinc-800/80 p-1.5 text-text-secondary group-hover:text-azure group-hover:bg-azure/10 transition-colors shadow-sm border border-zinc-700/50">
                                    <Icon className="h-3.5 w-3.5" />
                                </div>
                                <span className="text-[13px] font-semibold text-text-secondary group-hover:text-text-primary transition-colors tracking-wide">{item.label}</span>
                            </div>
                            <span className="text-[12px] text-text-muted leading-relaxed line-clamp-1">{item.desc}</span>
                        </button>
                    )
                })}
                {/* 6th Slot - Start a Project */}
                <Link
                    href="/projects/new"
                    className="group flex flex-col items-start gap-1.5 rounded-2xl border border-dashed border-zinc-700/40 bg-surface-1/20 px-4 py-3.5 text-left transition-all duration-300 hover:border-azure/40 hover:bg-azure/5 hover:-translate-y-0.5 hover:shadow-[0_8px_30px_-12px_rgba(99,102,241,0.15)]"
                >
                    <div className="flex items-center gap-2.5 mb-0.5 w-full">
                        <div className="rounded-lg bg-zinc-800/40 p-1.5 text-text-secondary group-hover:text-azure transition-colors border border-transparent group-hover:border-azure/20">
                            <Plus className="h-3.5 w-3.5" />
                        </div>
                        <span className="text-[13px] font-semibold text-text-secondary group-hover:text-text-primary transition-colors tracking-wide flex-1">More Options</span>
                        <ArrowRight className="h-3.5 w-3.5 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity translate-x-1 group-hover:translate-x-0" />
                    </div>
                    <span className="text-[12px] text-text-muted leading-relaxed">Start a complex project</span>
                </Link>
            </div>
        </div>
    )
}
