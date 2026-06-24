// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, memo } from 'react'
import Link from 'next/link'
import {
    User, CheckCircle2, XCircle, Loader2, Copy, Check, FileText, Circle,
    ChevronDown, ArrowUpRight, ListChecks,
} from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'
import { PlexoAwarenessBadge } from '@web/components/plexo-awareness-badge'
import type { ChatMessage, Message, TaskAsset } from './types'
import { isPlanProposalMessage } from './types'
import { PlanCard } from './plan-card'
import { AgentThinkingPanel } from './agent-thinking-panel'
import { AgentActivityPanel } from './agent-activity-panel'
import { KindBadge } from '@web/components/works/KindBadge'
import { resolveKind } from '@web/components/works/WorkRenderer'

// ── Inline markdown — renders links, bold, italic, code ────────────
// Lightweight: no heavy markdown lib needed for chat bubbles.
const INLINE_RE = /(\[([^\]]+)\]\(([^)]+)\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g

function InlineMarkdown({ text }: { text: string }) {
    const parts: React.ReactNode[] = []
    let last = 0
    let match: RegExpExecArray | null
    let key = 0

    while ((match = INLINE_RE.exec(text)) !== null) {
        if (match.index > last) parts.push(text.slice(last, match.index))

        if (match[1]) {
            // [text](url) — markdown link
            const href = match[3]!
            const isInternal = href.startsWith('/') || href.startsWith('#')
            if (isInternal) {
                parts.push(<Link key={key++} href={href} className="text-azure hover:underline">{match[2]}</Link>)
            } else {
                parts.push(<a key={key++} href={href} target="_blank" rel="noopener noreferrer" className="text-azure hover:underline">{match[2]}</a>)
            }
        } else if (match[4]) {
            // `code`
            parts.push(<code key={key++} className="rounded bg-surface-2/60 px-1 py-0.5 font-mono text-[0.9em] text-text-secondary">{match[4].slice(1, -1)}</code>)
        } else if (match[5]) {
            // **bold**
            parts.push(<strong key={key++} className="font-medium">{match[5].slice(2, -2)}</strong>)
        } else if (match[6]) {
            // *italic*
            parts.push(<em key={key++}>{match[6].slice(1, -1)}</em>)
        }

        last = match.index + match[0].length
    }

    if (last < text.length) parts.push(text.slice(last))
    return <>{parts}</>
}

function fmt(ms: number): string {
    const s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    return `${Math.floor(s / 3600)}h ago`
}

// ── PhaseIndicator (legacy fallback) ────────────────────────────────
function PhaseIndicator({ phases, currentPhase }: {
    phases: Array<{ index: number; total: number; label: string; status: 'pending' | 'running' | 'complete' }>
    currentPhase?: string
}) {
    const [expanded, setExpanded] = useState(false)
    const active = phases.find(p => p.status === 'running')
    const completed = phases.filter(p => p.status === 'complete').length
    const total = phases[0]?.total ?? phases.length

    if (total === 0) return null

    return (
        <div className="mb-1.5">
            <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? 'Hide progress steps' : 'Show progress steps'}
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-2 px-3 py-1 min-h-6 rounded-sm bg-surface-1/30 border border-border/20 hover:bg-surface-1/50 transition-all text-xs"
            >
                <Loader2 className="h-3 w-3 text-azure animate-spin" />
                <span className="text-text-secondary">
                    {active ? `${completed + 1}/${total} ${active.label}` : currentPhase ?? 'Processing'}
                </span>
                <ChevronDown className={`h-3 w-3 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>

            {expanded && (
                <div className="mt-1 pl-2 space-y-0.5">
                    {phases.map((phase, i) => (
                        <div key={i} className="flex items-center gap-2 text-[11px]">
                            {phase.status === 'complete' && <CheckCircle2 className="h-3 w-3 text-emerald-400" />}
                            {phase.status === 'running' && <Loader2 className="h-3 w-3 text-azure animate-spin" />}
                            {phase.status === 'pending' && <Circle className="h-3 w-3 text-text-muted/30" />}
                            <span className={phase.status === 'pending' ? 'text-text-muted/40' : phase.status === 'running' ? 'text-azure' : 'text-text-secondary'}>
                                {phase.label}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

/**
 * Compact, collapsible view of the accepted plan streamed on the reply-stream
 * tick. Shows the goal + each step's description and capability tag so a single
 * long step surfaces WHAT is being built instead of a bare "Thinking…" timer.
 * Expanded by default while the task runs.
 */
function LivePlanCard({ plan }: { plan: NonNullable<Message['livePlan']> }) {
    const [expanded, setExpanded] = useState(true)
    if (!plan.steps || plan.steps.length === 0) return null
    const conf = typeof plan.confidenceScore === 'number'
        ? `${Math.round(plan.confidenceScore * 100)}%`
        : null
    return (
        <div className="mb-1.5 w-full">
            <button
                type="button"
                aria-expanded={expanded}
                aria-label={expanded ? 'Hide plan' : 'Show plan'}
                onClick={() => setExpanded(!expanded)}
                className="flex items-center gap-2 px-3 py-1 min-h-6 rounded-sm bg-surface-1/30 border border-border/20 hover:bg-surface-1/50 transition-all text-xs w-full"
            >
                <ListChecks className="h-3 w-3 text-azure shrink-0" />
                <span className="text-text-secondary truncate flex-1 text-left">
                    {plan.goal ?? 'Plan'}{plan.steps.length > 1 ? ` · ${plan.steps.length} steps` : ''}
                </span>
                {conf && <span className="text-text-muted shrink-0">{conf}</span>}
                <ChevronDown className={`h-3 w-3 text-text-muted transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`} />
            </button>

            {expanded && (
                <div className="mt-1 pl-2 space-y-0.5">
                    {plan.steps.map((s) => (
                        <div key={s.n} className="flex items-start gap-2 text-[11px]">
                            <span className="text-text-muted/60 shrink-0">{s.n}.</span>
                            <span className="text-text-secondary">
                                {s.description}
                                {s.capability && <span className="text-azure/70"> · {s.capability}</span>}
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

// ── AssetCard ─────────────────────────────────────────────────────
function AssetCard({ asset, taskId, onOpen }: { asset: TaskAsset; taskId?: string; onOpen?: (asset: TaskAsset) => void }) {
    const sizeLabel = asset.bytes < 1024 ? `${asset.bytes}B` : asset.bytes < 1024 * 1024 ? `${(asset.bytes / 1024).toFixed(1)}KB` : `${(asset.bytes / (1024 * 1024)).toFixed(1)}MB`
    const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(asset.filename)
    const assetUrl = asset.url || (taskId ? `/api/v1/tasks/${taskId}/assets/${asset.filename}` : null)

    return (
        <button
           type="button"
           aria-label={`Open ${asset.filename}`}
           onClick={() => onOpen?.(asset)}
           className="group/asset flex flex-col gap-2 rounded-sm border border-border/60 bg-surface-2/50 p-2 cursor-pointer hover:bg-surface-2/40 transition-all list-none select-none text-left w-full max-w-full sm:max-w-[280px]"
        >
            {isImage && assetUrl && (
                <div className="relative aspect-video w-full overflow-hidden rounded-sm bg-surface-2 border border-border/30">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={assetUrl} alt={asset.filename} loading="lazy" className="h-full w-full object-cover transition-transform" />
                </div>
            )}
            <div className="flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-2 overflow-hidden">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                    <span className="flex-1 text-[11px] font-medium text-text-primary font-mono truncate">{asset.filename}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    <KindBadge kind={resolveKind(asset)} size="xs" />
                    <span className="text-[11px] text-text-muted break-keep">{sizeLabel}</span>
                </div>
            </div>
        </button>
    )
}

// ── MessageBubble ─────────────────────────────────────────────────
interface MessageBubbleProps {
    msg: ChatMessage
    onExecute: (id: string, intent: 'TASK' | 'PROJECT' | 'CONVERSATION', desc: string) => void
    onCancel: (id: string) => void
    onOpenAsset: (taskId: string, asset: TaskAsset) => void
    userInitial: string
}

function MessageBubbleBase(props: MessageBubbleProps) {
    if (isPlanProposalMessage(props.msg)) {
        return (
            <PlanCard
                taskId={props.msg.taskId}
                plan={props.msg.plan}
                requiresApproval={props.msg.requiresApproval}
                approvalId={props.msg.approvalId}
            />
        )
    }
    return <ChatBubble {...props} msg={props.msg} />
}

interface ChatBubbleProps extends Omit<MessageBubbleProps, 'msg'> {
    msg: Message
}

function ChatBubble({
    msg,
    onExecute,
    onCancel,
    onOpenAsset,
    userInitial,
}: ChatBubbleProps) {
    const [copied, setCopied] = useState(false)

    // Show phase indicator only after 1.5s to avoid flash on fast responses.
    // Computed in state+effect to avoid calling Date.now() during render.
    const [showPhaseIndicator, setShowPhaseIndicator] = useState(false)
    useEffect(() => {
        if (msg.role !== 'agent' || msg.status !== 'running' || !msg.phases?.length) {
            setShowPhaseIndicator(false)
            return
        }
        const elapsed = Date.now() - msg.at
        if (elapsed > 1500) { setShowPhaseIndicator(true); return }
        const timer = setTimeout(() => setShowPhaseIndicator(true), 1500 - elapsed)
        return () => clearTimeout(timer)
    }, [msg.role, msg.status, msg.at, msg.phases?.length])

    const imageStrip = msg.images && msg.images.length > 0 ? (
        <div className={`flex flex-wrap gap-2 mb-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {msg.images.map((img) => (
                img.kind === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        key={img.id}
                        src={img.dataUrl}
                        alt={img.name}
                        loading="lazy"
                        className="max-h-60 max-w-[300px] rounded-sm border border-border/50 object-cover transition-transform"
                    />
                ) : (
                    <div
                        key={img.id}
                        className="flex items-center gap-2 rounded-sm border border-border/60 bg-surface-2/60 px-3 py-2 text-xs text-text-secondary"
                    >
                        <FileText className="h-3.5 w-3.5 shrink-0 text-azure" />
                        <span className="font-medium truncate max-w-[160px]">{img.name}</span>
                        <span className="text-text-muted shrink-0 uppercase text-[11px] font-medium">{img.kind}</span>
                    </div>
                )
            ))}
        </div>
    ) : null

    const docStrip = msg.role === 'user' && msg.docs && msg.docs.length > 0 ? (
        <div className="flex flex-wrap gap-2 mb-2">
            {msg.docs.map((doc) => (
                <div
                    key={doc.id}
                    title={doc.content}
                    className="flex items-center gap-2 rounded-sm border border-border/60 bg-surface-2/60 px-3 py-2 text-xs text-text-secondary"
                >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                    <span className="font-medium truncate max-w-[160px]">{doc.name}</span>
                    <span className="text-text-muted shrink-0">{doc.lineCount} lines</span>
                </div>
            ))}
        </div>
    ) : null

    function copyMsg() {
        const text = msg.actionDescription
            ? `${msg.content}\n${msg.actionDescription}`
            : msg.content
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    return (
        <div
            key={msg.id}
            className={`group flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
        >
            <div className={`shrink-0 h-8 w-8 rounded-full flex items-center justify-center ${msg.role === 'user' ? 'bg-surface-2' : ' '}`}>
                {msg.role === 'user'
                    ? userInitial
                        ? <span className="text-sm font-medium text-text-primary select-none">{userInitial}</span>
                        : <User className="h-4 w-4 text-text-secondary" />
                    : <PlexoMark className="h-6 w-6" idle={msg.status !== 'queued' && msg.status !== 'running'} working={msg.status === 'queued' || msg.status === 'running'} />
                }
            </div>

            <div className={`relative flex flex-col gap-1 max-w-[85%] md:max-w-[80%] min-w-0 ${msg.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                {imageStrip}
                {docStrip}

                {msg.role === 'agent' && msg.sprint && msg.sprint.subAgents.length > 0 && (
                    <AgentActivityPanel
                        sprint={msg.sprint}
                        isRunning={msg.status === 'running' || msg.status === 'queued'}
                    />
                )}

                {msg.role === 'agent' && msg.livePlan
                    && (msg.status === 'running' || msg.status === 'queued') && (
                    <LivePlanCard plan={msg.livePlan} />
                )}

                {msg.role === 'agent' && (msg.progressEvents && msg.progressEvents.length > 0 || msg.status === 'running') && (
                    <AgentThinkingPanel
                        events={msg.progressEvents ?? []}
                        isRunning={msg.status === 'running' || msg.status === 'queued'}
                    />
                )}

                {/* Legacy fallback: only render the old phase chip when no new-style
                    progress events have been received yet (e.g. an older task
                    loaded from history). */}
                {msg.role === 'agent'
                    && (!msg.progressEvents || msg.progressEvents.length === 0)
                    && msg.status === 'running'
                    && showPhaseIndicator && (
                    <PhaseIndicator phases={msg.phases!} currentPhase={msg.currentPhase} />
                )}

                {/* Suppress the empty bubble while the agent is running and
                    the thinking panel is already conveying progress. Only
                    render the bubble container when there's something to say. */}
                {!(msg.role === 'agent' && (msg.status === 'running' || msg.status === 'queued')) && (
                <div className={`relative w-full overflow-x-auto rounded-sm px-4 py-2 text-[15px] leading-relaxed transition-all duration-300 ${msg.role === 'user'
                    ? 'bg-azure text-white rounded-tr-sm'
                    : msg.status === 'failed'
                        ? 'bg-red-500/10 border border-red-500/20 text-red-200 rounded-tl-sm'
                        : 'bg-surface-1/40 border border-border/40 text-text-primary rounded-tl-sm hover:bg-surface-1/60 hover:border-border/60'
                    }`}>
                    {msg.status === 'failed' ? (
                        <div className="flex flex-col gap-2">
                            <div className="flex items-start gap-1.5">
                                <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                <span className="leading-snug">{msg.content || 'Failed.'}</span>
                            </div>
                            {msg.fixUrl && (
                                <Link
                                    href={msg.fixUrl}
                                    className="inline-flex items-center gap-1 self-start rounded-md bg-red-900/40 border border-red-700/40 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-red-900/60 hover:text-red-200 transition-colors"
                                >
                                    {msg.fixLabel ?? 'Fix this'} →
                                </Link>
                            )}
                            {msg.role === 'agent' && msg.taskId && (
                                <Link
                                    href={`/app/tasks/${msg.taskId}`}
                                    aria-label="Open work detail page"
                                    className="inline-flex items-center gap-1 self-start rounded-md border border-red-800/40 bg-red-900/20 px-2.5 py-1 text-xs font-medium text-red-300/90 hover:bg-red-900/40 hover:text-red-200 transition-colors"
                                >
                                    Open work detail
                                    <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                                </Link>
                            )}
                            {msg.technicalDetail && (
                                <details className="group/td mt-0.5">
                                    <summary className="text-[11px] text-red/50 cursor-pointer hover:text-red/70 list-none flex items-center gap-1">
                                        <span className="group-open/td:hidden">▸ Technical details</span>
                                        <span className="hidden group-open/td:inline">▾ Technical details</span>
                                    </summary>
                                    <code className="block mt-1.5 text-[11px] text-red/50 font-mono break-all leading-relaxed bg-red-dim rounded p-2">
                                        {msg.technicalDetail}
                                    </code>
                                </details>
                            )}
                        </div>
                    ) : msg.status === 'confirm_action' && msg.intent === 'PROJECT' ? (
                        <div className="flex flex-col gap-3">
                            <span className="font-medium text-text-primary">
                                I can set this up as a coordinated project.
                            </span>

                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    aria-label="Create a coordinated project from this task"
                                    onClick={() => onExecute(msg.id, 'PROJECT', msg.actionDescription!)}
                                    className="rounded-sm bg-azure px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors"
                                >
                                    Create Project
                                </button>
                                <button
                                    type="button"
                                    aria-label="Dismiss project suggestion"
                                    onClick={() => onCancel(msg.id)}
                                    className="text-[11px] text-text-muted hover:text-text-secondary transition-colors"
                                >
                                    Dismiss
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            <span className="whitespace-pre-wrap break-words"><InlineMarkdown text={msg.content ?? ''} /></span>
                            {msg.fixUrl && (
                                <Link
                                    href={msg.fixUrl}
                                    className="inline-flex items-center gap-1 self-start rounded-md bg-surface-2/60 border border-border/50 px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
                                >
                                    {msg.fixLabel ?? 'View'} →
                                </Link>
                            )}
                            {msg.role === 'agent' && msg.status === 'complete' && msg.taskId && (
                                <Link
                                    href={`/app/tasks/${msg.taskId}`}
                                    aria-label="Open work detail page"
                                    className="inline-flex items-center gap-1 self-start rounded-md border border-azure/30 bg-azure-dim/40 px-2.5 py-1 text-xs font-medium text-azure hover:bg-azure-dim hover:text-azure transition-colors"
                                >
                                    Open work detail
                                    <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                                </Link>
                            )}
                            {msg.assets && msg.assets.length > 0 && (
                                <div className="flex flex-col gap-1.5 mt-1">
                                    {msg.assets.map((asset) => (
                                        <AssetCard
                                            key={asset.filename}
                                            asset={asset}
                                            taskId={msg.taskId}
                                            onOpen={(a) => msg.taskId && onOpenAsset(msg.taskId, a)}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                </div>
                )}

                {msg.status !== 'queued' && msg.status !== 'running' && msg.status !== 'confirm_action' && msg.content && (
                    <button
                        type="button"
                        onClick={copyMsg}
                        aria-label={copied ? 'Copied!' : 'Copy message'}
                        className="absolute -top-2 right-0 opacity-0 group-hover:opacity-100 transition-opacity rounded-md bg-surface-2 border border-border p-1 text-text-secondary hover:text-text-primary hover:bg-surface-3 z-10"
                        title={copied ? 'Copied!' : 'Copy'}
                    >
                        {copied
                            ? <Check className="h-3 w-3 text-azure" />
                            : <Copy className="h-3 w-3" />
                        }
                    </button>
                )}

                <div className="flex items-center gap-2 text-[11px] text-text-muted font-mono">
                    <span>{fmt(msg.at)}</span>
                    {msg.taskId && (
                        <Link
                            href={`/app/tasks/${msg.taskId}`}
                            className="hover:text-text-secondary transition-colors font-mono"
                        >
                            {msg.taskId.slice(0, 8)} ↗
                        </Link>
                    )}
                    {msg.model && (() => {
                        const [provider, ...rest] = msg.model!.split('/')
                        const modelName = rest.join('/') || provider
                        const providerColors: Record<string, string> = {
                            deepseek: 'bg-blue-500/15 text-blue-400',
                            anthropic: 'bg-amber-500/15 text-amber-400',
                            openai: 'bg-signal-green/15 text-emerald-400',
                            google: 'bg-sky-500/15 text-sky-400',
                            groq: 'bg-orange-500/15 text-orange-400',
                            ollama: 'bg-purple-500/15 text-purple-400',
                        }
                        const color = providerColors[provider] ?? 'bg-surface-2 text-text-muted'
                        return (
                            <span className="flex items-center gap-1">
                                <span className={`rounded px-1 py-px text-[10px] font-medium ${color}`}>{provider}</span>
                                <span className="font-mono opacity-60">{modelName}</span>
                            </span>
                        )
                    })()}
                    {msg.status === 'complete' && (
                        <CheckCircle2 className="h-3 w-3 text-azure" />
                    )}
                    {msg.role === 'agent' && msg.status === 'complete' && (
                        <PlexoAwarenessBadge action="Plexo" compact />
                    )}
                </div>
            </div>
        </div>
    )
}

export const MessageBubble = memo(MessageBubbleBase)
