// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import {
    Brain, Search, Globe, Wrench, Sparkles, Code, FileText, Database,
    Send, Circle, CheckCircle2, XCircle, Loader2, ChevronRight, ChevronDown,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────
export type ProgressEventKind =
    | 'phase'
    | 'thinking'
    | 'reasoning'
    | 'web_search'
    | 'web_fetch'
    | 'tool_call'
    | 'llm_call'
    | 'code_exec'
    | 'file_write'
    | 'file_read'
    | 'memory'
    | 'learning'
    | 'channel_send'
    | 'error'
    | 'status'
    | 'unknown'

export interface ProgressEvent {
    id: string
    kind: ProgressEventKind
    title: string
    detail?: string
    toolName?: string
    input?: unknown
    output?: unknown
    error?: string
    startedAt: number
    completedAt?: number
    status: 'running' | 'success' | 'error'
}

/**
 * Raw event shape emitted by the API tick payload. The server-side
 * classifier emits a narrower `kind` set than the UI supports; we
 * upgrade/normalise it here before rendering.
 */
export interface RawProgressEvent {
    id: string
    kind: string
    title: string
    toolName?: string
    input?: unknown
    output?: unknown
    error?: string
    startedAt: number
    completedAt?: number
    status: 'running' | 'success' | 'error'
}

// ── Normalization ────────────────────────────────────────────────────────

function inferKind(raw: RawProgressEvent): ProgressEventKind {
    const kind = raw.kind
    if (kind === 'phase' || kind === 'memory' || kind === 'learning' || kind === 'error' || kind === 'status') {
        return kind
    }
    if (kind === 'tool_call') {
        const name = (raw.toolName ?? '').toLowerCase()
        if (name === 'read_file') return 'file_read'
        if (name === 'write_file') return 'file_write'
        if (name === 'shell' || name === 'exec' || name === 'code_exec') return 'code_exec'
        if (name.includes('web_search') || name.includes('search_web') || name.includes('search')) return 'web_search'
        if (name.includes('web_fetch') || name.includes('fetch_url') || name.includes('fetch')) return 'web_fetch'
        if (name.includes('send') || name.includes('notify') || name.includes('message')) return 'channel_send'
        if (name.includes('memory') || name.includes('remember')) return 'memory'
        return 'tool_call'
    }
    return 'unknown'
}

export function normalizeEvents(raws: RawProgressEvent[] | undefined): ProgressEvent[] {
    if (!raws || raws.length === 0) return []
    return raws.map(r => ({
        id: r.id,
        kind: inferKind(r),
        title: r.title,
        toolName: r.toolName,
        input: r.input,
        output: r.output,
        error: r.error,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        status: r.status,
    }))
}

// ── Grouping ─────────────────────────────────────────────────────────────

interface EventGroup {
    key: string
    kind: ProgressEventKind
    events: ProgressEvent[]
}

/**
 * Collapse runs of the same-kind events (e.g. 5 consecutive web fetches)
 * into a single row so the panel stays scannable.
 */
function groupEvents(events: ProgressEvent[]): EventGroup[] {
    const groups: EventGroup[] = []
    for (const ev of events) {
        const last = groups[groups.length - 1]
        const canGroup =
            last &&
            last.kind === ev.kind &&
            last.kind !== 'phase' &&
            last.kind !== 'error' &&
            last.events.length < 20
        if (canGroup) {
            last.events.push(ev)
        } else {
            groups.push({ key: ev.id, kind: ev.kind, events: [ev] })
        }
    }
    return groups
}

// ── Icon + label mapping ─────────────────────────────────────────────────

const KIND_META: Record<ProgressEventKind, { Icon: typeof Brain; label: string }> = {
    phase:        { Icon: Sparkles, label: 'Phase' },
    thinking:     { Icon: Brain,    label: 'Thinking' },
    reasoning:    { Icon: Brain,    label: 'Reasoning' },
    web_search:   { Icon: Search,   label: 'Web search' },
    web_fetch:    { Icon: Globe,    label: 'Fetching' },
    tool_call:    { Icon: Wrench,   label: 'Tool' },
    llm_call:     { Icon: Sparkles, label: 'Calling model' },
    code_exec:    { Icon: Code,     label: 'Running code' },
    file_write:   { Icon: FileText, label: 'Writing file' },
    file_read:    { Icon: FileText, label: 'Reading file' },
    memory:       { Icon: Database, label: 'Remembering' },
    learning:     { Icon: Brain,    label: 'Learning' },
    channel_send: { Icon: Send,     label: 'Sending' },
    error:        { Icon: XCircle,  label: 'Error' },
    status:       { Icon: Circle,   label: 'Status' },
    unknown:      { Icon: Circle,   label: 'Working' },
}

// ── Duration formatting ──────────────────────────────────────────────────

function formatDuration(ms: number): string {
    if (ms < 1_000) return `${ms}ms`
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
    const m = Math.floor(ms / 60_000)
    const s = Math.round((ms % 60_000) / 1_000)
    return `${m}m ${s}s`
}

function formatElapsed(startedAt: number, now: number): string {
    return formatDuration(Math.max(0, now - startedAt))
}

// ── Row components ───────────────────────────────────────────────────────

interface StepRowProps {
    group: EventGroup
    expanded: boolean
    onToggle: () => void
}

function StepRow({ group, expanded, onToggle }: StepRowProps) {
    const first = group.events[0]!
    const last = group.events[group.events.length - 1]!
    const { Icon } = KIND_META[group.kind]
    const count = group.events.length
    const isRunning = last.status === 'running'
    const hasError = group.events.some(e => e.status === 'error')

    const title = count > 1
        ? group.kind === 'web_fetch' ? `Fetched ${count} URLs`
          : group.kind === 'web_search' ? `Ran ${count} searches`
          : group.kind === 'file_read' ? `Read ${count} files`
          : group.kind === 'file_write' ? `Wrote ${count} files`
          : group.kind === 'tool_call' ? `${count} tool calls`
          : `${count} × ${KIND_META[group.kind].label.toLowerCase()}`
        : first.title

    const duration = last.completedAt
        ? formatDuration(last.completedAt - first.startedAt)
        : null

    return (
        <div className={`rounded-md transition-colors ${expanded ? 'bg-surface-2/60' : 'hover:bg-surface-1/40'}`}>
            <button
                type="button"
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} step: ${title}`}
                onClick={onToggle}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-[12px] leading-snug"
            >
                <span className="shrink-0 w-3.5 h-3.5 flex items-center justify-center text-text-muted/70">
                    {expanded
                        ? <ChevronDown className="w-3 h-3" />
                        : <ChevronRight className="w-3 h-3" />}
                </span>
                <span className={`shrink-0 w-4 h-4 flex items-center justify-center ${
                    hasError ? 'text-red-400'
                    : isRunning ? 'text-azure'
                    : 'text-text-secondary'
                }`}>
                    {isRunning
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : hasError
                            ? <XCircle className="w-3.5 h-3.5" />
                            : <Icon className="w-3.5 h-3.5" />}
                </span>
                <span className={`flex-1 truncate ${
                    hasError ? 'text-red-300'
                    : isRunning ? 'text-text-primary'
                    : 'text-text-secondary'
                } ${isRunning ? 'animate-pulse' : ''}`}>
                    {title}
                </span>
                {duration && (
                    <span className="shrink-0 text-[10px] text-text-muted/60 tabular-nums">
                        {duration}
                    </span>
                )}
                {!duration && isRunning && (
                    <span className="shrink-0 text-[10px] text-azure/70 tabular-nums">
                        <Pulse />
                    </span>
                )}
            </button>

            {expanded && (
                <div className="pl-7 pr-2 pb-2 space-y-2">
                    {group.events.map(ev => (
                        <EventDetail key={ev.id} ev={ev} />
                    ))}
                </div>
            )}
        </div>
    )
}

function EventDetail({ ev }: { ev: ProgressEvent }) {
    return (
        <div className="text-[11px] space-y-1 border-l border-border/40 pl-3">
            {ev.toolName && (
                <div className="font-mono text-text-muted/80">{ev.toolName}</div>
            )}
            {ev.input !== undefined && ev.input !== null && (
                <details>
                    <summary className="cursor-pointer text-text-muted/70 hover:text-text-secondary">
                        Input
                    </summary>
                    <pre className="mt-1 p-2 rounded bg-surface-2/60 border border-border/30 overflow-x-auto max-h-48 text-text-muted/90 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all">
                        {safeStringify(ev.input)}
                    </pre>
                </details>
            )}
            {ev.output !== undefined && ev.output !== null && ev.output !== '' && (
                <details>
                    <summary className="cursor-pointer text-text-muted/70 hover:text-text-secondary">
                        Output
                    </summary>
                    <pre className="mt-1 p-2 rounded bg-surface-2/60 border border-border/30 overflow-x-auto max-h-48 text-text-muted/90 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all">
                        {safeStringify(ev.output)}
                    </pre>
                </details>
            )}
            {ev.error && (
                <div className="p-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all">
                    {ev.error}
                </div>
            )}
            {ev.completedAt && (
                <div className="text-text-muted/50 tabular-nums">
                    Took {formatDuration(ev.completedAt - ev.startedAt)}
                </div>
            )}
        </div>
    )
}

function safeStringify(v: unknown): string {
    if (typeof v === 'string') return v
    try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

function Pulse() {
    return <span className="inline-block w-1 h-1 rounded-full bg-azure animate-ping" aria-hidden="true" />
}

// ── Panel ────────────────────────────────────────────────────────────────

interface AgentThinkingPanelProps {
    events: ProgressEvent[]
    isRunning: boolean
    /**
     * When the overall task finished we compact the panel into a single
     * "N steps · Xs · Show details" line. Defaults to collapsing.
     */
    compactOnComplete?: boolean
}

function AgentThinkingPanelBase({ events, isRunning, compactOnComplete = true }: AgentThinkingPanelProps) {
    const groups = useMemo(() => groupEvents(events), [events])

    // Live ticking counter so "Thinking... 12s" updates every 500ms.
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!isRunning) return
        const id = setInterval(() => setNow(Date.now()), 500)
        return () => clearInterval(id)
    }, [isRunning])

    // Anchor the elapsed timer to the moment the task started running so
    // we can show a counting "Thinking… 12s" even when zero progress
    // events have been persisted yet (deepseek-reasoner blocks for 30–90s
    // before the first task_steps row exists, and prior to this anchor
    // `firstStart = events[0]?.startedAt ?? now` recomputed `now` on
    // every render, so the timer was permanently pinned at 0ms).
    const [runStartedAt, setRunStartedAt] = useState<number | null>(null)
    useEffect(() => {
        if (isRunning && runStartedAt == null) {
            setRunStartedAt(Date.now())
        } else if (!isRunning) {
            setRunStartedAt(null)
        }
    }, [isRunning, runStartedAt])

    // Per-group expansion state (keyed by group.key).
    const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    const toggle = (key: string) => setExpanded(s => ({ ...s, [key]: !s[key] }))

    // Compact mode on complete — the whole panel folds to a summary line.
    const [compactOpen, setCompactOpen] = useState(false)

    // Auto-scroll latest step into view, but only if the user is already
    // near the bottom of the panel (so manual scroll-up isn't stolen).
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const stickToBottom = useRef(true)

    useLayoutEffect(() => {
        const el = scrollRef.current
        if (!el) return
        if (stickToBottom.current) {
            el.scrollTop = el.scrollHeight
        }
    }, [groups.length])

    const onScroll = () => {
        const el = scrollRef.current
        if (!el) return
        const dist = el.scrollHeight - (el.scrollTop + el.clientHeight)
        stickToBottom.current = dist < 24
    }

    // First-event timestamp drives the "Thinking... 12s" header. Falls
    // back to the anchored runStartedAtRef (set when isRunning flipped
    // true) so the timer counts from task start, then to `now` as a
    // last resort. The anchored ref is what fixes the 0ms pin bug.
    const firstStart = events[0]?.startedAt ?? runStartedAt ?? now
    const lastEvent = events[events.length - 1]
    const lastCompleted = lastEvent?.completedAt
    const totalDuration = lastCompleted
        ? formatDuration(lastCompleted - firstStart)
        : formatElapsed(firstStart, now)

    const errorEvents = events.filter(e => e.status === 'error')
    const stepCount = events.length

    // ── Empty fallback: running but no events yet ────────────────────────
    if (events.length === 0) {
        if (!isRunning) return null
        return (
            <div className="mb-1.5 rounded-sm border border-border/40 bg-surface-1/40 px-3 py-2 flex items-center gap-2 text-[12px]">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-azure" />
                <span className="text-text-secondary animate-pulse">Thinking…</span>
                <span className="ml-auto text-[10px] text-text-muted/60 tabular-nums">
                    {totalDuration}
                </span>
            </div>
        )
    }

    // ── Compact mode (task complete) ─────────────────────────────────────
    if (!isRunning && compactOnComplete && !compactOpen) {
        const hasErr = errorEvents.length > 0
        return (
            <div className="mb-1.5">
                <button
                    type="button"
                    aria-label="Show agent thinking details"
                    onClick={() => setCompactOpen(true)}
                    className="inline-flex items-center gap-2 rounded-md border border-border/30 bg-surface-1/30 hover:bg-surface-1/50 px-2 py-1 min-h-6 text-[11px] text-text-secondary transition-colors"
                >
                    <ChevronRight className="w-3 h-3" />
                    <span>{stepCount} step{stepCount !== 1 ? 's' : ''}</span>
                    <span className="text-text-muted/40">·</span>
                    <span className="tabular-nums">{totalDuration}</span>
                    {hasErr && (
                        <>
                            <span className="text-text-muted/40">·</span>
                            <span className="text-red-400">{errorEvents.length} error{errorEvents.length !== 1 ? 's' : ''}</span>
                        </>
                    )}
                    <span className="text-text-muted/40">·</span>
                    <span className="text-text-muted/80">Show details</span>
                </button>
                {hasErr && errorEvents[0] && (
                    <div className="mt-1 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                        {errorEvents[0].title}
                    </div>
                )}
            </div>
        )
    }

    // ── Full expanded panel ──────────────────────────────────────────────
    return (
        <div className="mb-2 rounded-sm border border-border/40 bg-surface-1/30 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border/30 bg-surface-1/40">
                {isRunning
                    ? <Loader2 className="w-3.5 h-3.5 text-azure animate-spin" />
                    : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                <span className="text-[12px] font-medium text-text-primary">
                    {isRunning ? 'Thinking…' : 'Done'}
                </span>
                <span className="ml-auto text-[11px] text-text-secondary tabular-nums">
                    {totalDuration}
                </span>
                {!isRunning && compactOnComplete && (
                    <button
                        type="button"
                        aria-label="Hide agent thinking details"
                        onClick={() => setCompactOpen(false)}
                        className="text-[10px] text-text-muted/60 hover:text-text-secondary ml-2"
                    >
                        hide
                    </button>
                )}
            </div>

            <div
                ref={scrollRef}
                onScroll={onScroll}
                className="max-h-64 overflow-y-auto py-1 px-1"
            >
                {groups.map(group => (
                    <StepRow
                        key={group.key}
                        group={group}
                        expanded={!!expanded[group.key]}
                        onToggle={() => toggle(group.key)}
                    />
                ))}
            </div>
        </div>
    )
}

export const AgentThinkingPanel = memo(AgentThinkingPanelBase)
