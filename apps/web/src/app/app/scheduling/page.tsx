// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { useState, useEffect, useCallback, useMemo } from 'react'
import {
    Clock,
    Plus,
    Trash2,
    ToggleLeft,
    ToggleRight,
    RefreshCw,
    Play,
    CheckCircle2,
    XCircle,
    AlertCircle,
    Zap,
    Bell,
    Send,
    Hash,
    Phone,
    Mail,
    Webhook,
    MessageSquare,
} from 'lucide-react'
import { useWorkspaceId } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ─────────────────────────────────────────────────────────────────────

interface CronJob {
    id: string
    name: string
    schedule: string | null
    scheduleAt?: string | null
    taskType?: string | null
    taskContext?: Record<string, unknown> | null
    enabled: boolean
    lastRunAt: string | null
    lastRunStatus: 'success' | 'failure' | null
    consecutiveFailures: number
    createdAt: string
}

type ChannelType = 'telegram' | 'slack' | 'discord' | 'whatsapp' | 'signal' | 'matrix' | 'twilio' | 'gmail'

interface Channel {
    id: string
    type: ChannelType
    name: string
    enabled: boolean
}

type Tab = 'reminder' | 'schedule'

// ── Config ────────────────────────────────────────────────────────────────────

const PRESETS = [
    { label: 'Every 5 minutes', value: '*/5 * * * *' },
    { label: 'Every 15 minutes', value: '*/15 * * * *' },
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Every 6 hours', value: '0 */6 * * *' },
    { label: 'Daily at midnight', value: '0 0 * * *' },
    { label: 'Weekly (Mon 9am)', value: '0 9 * * 1' },
]

const TASK_TYPES = ['agent', 'reminder', 'webhook', 'extension'] as const

const CHANNEL_META: Record<ChannelType, { label: string; icon: React.ElementType; color: string }> = {
    telegram: { label: 'Telegram', icon: Send, color: 'text-sky-400' },
    slack: { label: 'Slack', icon: Hash, color: 'text-azure' },
    discord: { label: 'Discord', icon: MessageSquare, color: 'text-azure' },
    whatsapp: { label: 'WhatsApp', icon: MessageSquare, color: 'text-green-400' },
    signal: { label: 'Signal', icon: Send, color: 'text-azure' },
    matrix: { label: 'Matrix', icon: Hash, color: 'text-purple-400' },
    twilio: { label: 'SMS (Twilio)', icon: Phone, color: 'text-rose-400' },
    gmail: { label: 'Gmail', icon: Mail, color: 'text-red-400' },
}

const FILTER_KEYS = ['enabled'] as const
const MAX_MESSAGE_LEN = 4000
const COUNTER_THRESHOLD = 3500

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

function relativeFuture(iso: string): string {
    const s = Math.floor((new Date(iso).getTime() - Date.now()) / 1000)
    if (s <= 0) return 'now'
    if (s < 60) return `in ${s}s`
    if (s < 3600) return `in ${Math.floor(s / 60)}m`
    if (s < 86400) return `in ${Math.floor(s / 3600)}h`
    return `in ${Math.floor(s / 86400)}d`
}

function formatAbsolute(iso: string): string {
    try {
        return new Date(iso).toLocaleString()
    } catch {
        return iso
    }
}

/** Convert datetime-local input value (no timezone) → ISO string in browser tz. */
export function datetimeLocalToIso(value: string): string | null {
    if (!value) return null
    const d = new Date(value)
    if (isNaN(d.getTime())) return null
    return d.toISOString()
}

/** Convert ISO string → datetime-local input value. */
export function isoToDatetimeLocal(iso: string): string {
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Auto-derive a name for a reminder from its message (first ~40 chars). */
export function deriveReminderName(message: string): string {
    const trimmed = message.trim().replace(/\s+/g, ' ')
    if (!trimmed) return 'Reminder'
    return trimmed.length <= 40 ? trimmed : `${trimmed.slice(0, 40)}…`
}

/** Build the body submitted to POST /cron for a reminder. */
export function buildReminderBody(opts: {
    workspaceId: string
    scheduleAtIso: string
    channel: string
    message: string
}): Record<string, unknown> {
    return {
        workspaceId: opts.workspaceId,
        name: deriveReminderName(opts.message),
        scheduleAt: opts.scheduleAtIso,
        taskType: 'reminder',
        taskContext: {
            channelId: opts.channel,
            message: opts.message,
        },
    }
}

/** Build the body submitted to POST /cron for a recurring schedule. */
export function buildScheduleBody(opts: {
    workspaceId: string
    name: string
    schedule: string
    taskType?: string
    taskContext?: Record<string, unknown>
}): Record<string, unknown> {
    const body: Record<string, unknown> = {
        workspaceId: opts.workspaceId,
        name: opts.name,
        schedule: opts.schedule,
    }
    if (opts.taskType) body.taskType = opts.taskType
    if (opts.taskContext && Object.keys(opts.taskContext).length > 0) {
        body.taskContext = opts.taskContext
    }
    return body
}

function StatusIcon({ status }: { status: CronJob['lastRunStatus'] }) {
    if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-azure" />
    if (status === 'failure') return <XCircle className="h-4 w-4 text-red" />
    return <Clock className="h-4 w-4 text-text-muted" />
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function SchedulingPage() {
    const WS_ID = useWorkspaceId()

    const [jobs, setJobs] = useState<CronJob[]>([])
    const [channels, setChannels] = useState<Channel[]>([])
    const [loading, setLoading] = useState(true)
    const [adding, setAdding] = useState(false)
    const [activeTab, setActiveTab] = useState<Tab>('reminder')

    // Reminder form state
    const [remDatetime, setRemDatetime] = useState('')
    const [remNlText, setRemNlText] = useState('')
    const [remNlParsing, setRemNlParsing] = useState(false)
    const [remMessage, setRemMessage] = useState('')
    const [remChannel, setRemChannel] = useState('')
    const [remSaving, setRemSaving] = useState(false)

    // Schedule form state
    const [schName, setSchName] = useState('')
    const [schSchedule, setSchSchedule] = useState('')
    const [schNlText, setSchNlText] = useState('')
    const [schNlParsed, setSchNlParsed] = useState<{ cron: string; description: string } | null>(null)
    const [schNlParsing, setSchNlParsing] = useState(false)
    const [schTaskType, setSchTaskType] = useState<string>('')
    const [schAdvancedOpen, setSchAdvancedOpen] = useState(false)
    const [schTaskContextJson, setSchTaskContextJson] = useState('')
    const [schSaving, setSchSaving] = useState(false)

    const [triggering, setTriggering] = useState<string | null>(null)
    const [toggling, setToggling] = useState<string | null>(null)
    const [deleting, setDeleting] = useState<string | null>(null)
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues } = lf

    // L4 v1 ships gmail-only reminders; the dropdown filters on type accordingly.
    const gmailChannels = useMemo(() => channels.filter((c) => c.type === 'gmail'), [channels])

    // ── Data loading ──────────────────────────────────────────────────────────
    const fetchJobs = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const [jobsRes, chRes] = await Promise.all([
                fetch(`${API_BASE}/api/v1/cron?workspaceId=${WS_ID}`),
                fetch(`${API_BASE}/api/v1/channels?workspaceId=${WS_ID}`),
            ])
            if (jobsRes.ok) {
                const data = await jobsRes.json() as { items: CronJob[] }
                setJobs(data.items ?? [])
            }
            if (chRes.ok) {
                const data = await chRes.json() as { items: Channel[] }
                setChannels((data.items ?? []).filter((c) => c.enabled))
            }
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchJobs() }, [fetchJobs])

    // ── Filter dimensions ─────────────────────────────────────────────────────
    const dimensions = useMemo((): FilterDimension[] => [
        {
            key: 'enabled',
            label: 'State',
            options: [
                { value: 'true', label: 'Enabled' },
                { value: 'false', label: 'Disabled' },
            ],
        },
    ], [])

    // ── Partition jobs into reminders + schedules ────────────────────────────
    const partitioned = useMemo(() => {
        const q = search.trim().toLowerCase()
        const matches = (j: CronJob) => {
            if (filterValues.enabled === 'true' && !j.enabled) return false
            if (filterValues.enabled === 'false' && j.enabled) return false
            if (q) {
                return (
                    j.name.toLowerCase().includes(q) ||
                    (j.schedule ?? '').toLowerCase().includes(q)
                )
            }
            return true
        }
        const reminders = jobs.filter((j) => !j.schedule && matches(j))
        const schedules = jobs.filter((j) => j.schedule && matches(j))
        const sortFn = (a: CronJob, b: CronJob) => {
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        }
        return {
            reminders: [...reminders].sort(sortFn),
            schedules: [...schedules].sort(sortFn),
        }
    }, [jobs, search, filterValues.enabled])

    // ── Mutations: reminder NL parse ──────────────────────────────────────────
    async function handleReminderParseNl() {
        if (!remNlText.trim()) return
        setRemNlParsing(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/cron/parse-nl`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: remNlText }),
            })
            if (res.ok) {
                const d = await res.json() as { scheduleAt?: string; cron?: string; description?: string }
                if (d.scheduleAt) {
                    setRemDatetime(isoToDatetimeLocal(d.scheduleAt))
                } else {
                    setMessage({ ok: false, text: 'That looks like a recurring schedule — try the Schedule tab.' })
                }
            } else {
                setMessage({ ok: false, text: 'Could not parse — try e.g. "remind me at 3pm tomorrow"' })
            }
        } finally {
            setRemNlParsing(false)
        }
    }

    // ── Mutations: schedule NL parse ─────────────────────────────────────────
    async function handleScheduleParseNl() {
        if (!schNlText.trim()) return
        setSchNlParsing(true)
        setSchNlParsed(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/cron/parse-nl`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: schNlText }),
            })
            if (res.ok) {
                const d = await res.json() as { cron?: string; description?: string }
                if (d.cron) {
                    setSchNlParsed({ cron: d.cron, description: d.description ?? '' })
                    setSchSchedule(d.cron)
                } else {
                    setMessage({ ok: false, text: 'Could not parse that schedule — try e.g. "every day at 9am"' })
                }
            }
        } finally {
            setSchNlParsing(false)
        }
    }

    // ── Mutations: reminder submit ────────────────────────────────────────────
    async function handleAddReminder() {
        if (!WS_ID) return
        const iso = datetimeLocalToIso(remDatetime)
        if (!iso || !remMessage.trim() || !remChannel) {
            setMessage({ ok: false, text: 'Pick a time, write a message, and choose a channel.' })
            return
        }
        if (remMessage.length > MAX_MESSAGE_LEN) {
            setMessage({ ok: false, text: `Message too long (max ${MAX_MESSAGE_LEN}).` })
            return
        }
        setRemSaving(true)
        setMessage(null)
        try {
            const body = buildReminderBody({
                workspaceId: WS_ID,
                scheduleAtIso: iso,
                channel: remChannel,
                message: remMessage,
            })
            const res = await fetch(`${API_BASE}/api/v1/cron`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (res.ok) {
                setMessage({ ok: true, text: 'Reminder set' })
                setAdding(false)
                setRemDatetime('')
                setRemNlText('')
                setRemMessage('')
                setRemChannel('')
                void fetchJobs()
            } else {
                const err = await res.json() as { error?: { message?: string } }
                setMessage({ ok: false, text: err.error?.message ?? 'Failed' })
            }
        } finally {
            setRemSaving(false)
        }
    }

    // ── Mutations: schedule submit ────────────────────────────────────────────
    async function handleAddSchedule() {
        if (!WS_ID) return
        if (!schName.trim() || !schSchedule.trim()) {
            setMessage({ ok: false, text: 'Name and cron expression required.' })
            return
        }
        let parsedContext: Record<string, unknown> | undefined
        if (schTaskContextJson.trim()) {
            try {
                parsedContext = JSON.parse(schTaskContextJson) as Record<string, unknown>
            } catch {
                setMessage({ ok: false, text: 'Task context is not valid JSON.' })
                return
            }
        }
        setSchSaving(true)
        setMessage(null)
        try {
            const body = buildScheduleBody({
                workspaceId: WS_ID,
                name: schName,
                schedule: schSchedule,
                taskType: schTaskType || undefined,
                taskContext: parsedContext,
            })
            const res = await fetch(`${API_BASE}/api/v1/cron`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (res.ok) {
                setMessage({ ok: true, text: `${schName} scheduled` })
                setAdding(false)
                setSchName('')
                setSchSchedule('')
                setSchNlText('')
                setSchNlParsed(null)
                setSchTaskType('')
                setSchTaskContextJson('')
                setSchAdvancedOpen(false)
                void fetchJobs()
            } else {
                const err = await res.json() as { error?: { message?: string } }
                setMessage({ ok: false, text: err.error?.message ?? 'Failed' })
            }
        } finally {
            setSchSaving(false)
        }
    }

    async function handleToggle(job: CronJob) {
        setToggling(job.id)
        try {
            await fetch(`${API_BASE}/api/v1/cron/${job.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, enabled: !job.enabled }),
            })
            setJobs((p) => p.map((j) => j.id === job.id ? { ...j, enabled: !j.enabled } : j))
        } finally {
            setToggling(null)
        }
    }

    async function handleTrigger(job: CronJob) {
        setTriggering(job.id)
        setMessage(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/cron/${job.id}/trigger`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID }),
            })
            const data = await res.json() as { message?: string }
            setMessage({ ok: res.ok, text: data.message ?? (res.ok ? 'Triggered' : 'Failed') })
            void fetchJobs()
        } finally {
            setTriggering(null)
        }
    }

    async function handleDelete(id: string) {
        setDeleting(id)
        try {
            await fetch(`${API_BASE}/api/v1/cron/${id}?workspaceId=${WS_ID}`, { method: 'DELETE' })
            setJobs((p) => p.filter((j) => j.id !== id))
        } finally {
            setDeleting(null)
        }
    }

    const totalCount = jobs.length

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-medium text-text-primary">Scheduling</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        {loading
                            ? '…'
                            : `${partitioned.reminders.length} reminder${partitioned.reminders.length === 1 ? '' : 's'}, ${partitioned.schedules.length} schedule${partitioned.schedules.length === 1 ? '' : 's'}`}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void fetchJobs()}
                        disabled={loading}
                        aria-label="Refresh"
                        className="rounded-sm border border-border bg-surface-1 p-2 text-text-muted hover:text-text-secondary transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => setAdding(true)}
                        className="flex items-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        New
                    </button>
                </div>
            </div>

            {message && (
                <div className={`rounded-sm border px-3 py-2.5 text-sm ${message.ok ? 'border-azure/30 bg-azure/30 text-azure' : 'border-red-800/50 bg-red-dim text-red'}`}>
                    {message.text}
                </div>
            )}

            {/* Add panel with tabs */}
            {adding && (
                <div className="rounded-sm border border-azure/30 bg-surface-1/60 p-4 flex flex-col gap-4">
                    {/* Tab buttons */}
                    <div role="tablist" aria-label="Add type" className="flex items-center gap-1 border-b border-border">
                        <button
                            type="button"
                            role="tab"
                            id="tab-reminder"
                            aria-pressed={activeTab === 'reminder'}
                            aria-selected={activeTab === 'reminder'}
                            aria-controls="panel-reminder"
                            onClick={() => setActiveTab('reminder')}
                            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === 'reminder'
                                ? 'border-azure text-azure'
                                : 'border-transparent text-text-muted hover:text-text-secondary'
                                }`}
                        >
                            <Bell className="h-3.5 w-3.5" />
                            Reminder
                        </button>
                        <button
                            type="button"
                            role="tab"
                            id="tab-schedule"
                            aria-pressed={activeTab === 'schedule'}
                            aria-selected={activeTab === 'schedule'}
                            aria-controls="panel-schedule"
                            onClick={() => setActiveTab('schedule')}
                            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${activeTab === 'schedule'
                                ? 'border-azure text-azure'
                                : 'border-transparent text-text-muted hover:text-text-secondary'
                                }`}
                        >
                            <Clock className="h-3.5 w-3.5" />
                            Schedule
                        </button>
                        <button
                            onClick={() => { setAdding(false); setMessage(null) }}
                            className="ml-auto rounded-sm border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
                        >
                            Cancel
                        </button>
                    </div>

                    {/* Reminder panel */}
                    {activeTab === 'reminder' && (
                        <div
                            id="panel-reminder"
                            role="tabpanel"
                            aria-labelledby="tab-reminder"
                            data-testid="reminder-panel"
                            className="flex flex-col gap-4"
                        >
                            <h2 className="text-sm font-medium text-text-primary">New reminder</h2>

                            {/* NL input */}
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-medium text-text-secondary">Describe when in plain English</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={remNlText}
                                        onChange={(e) => setRemNlText(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') void handleReminderParseNl() }}
                                        placeholder='e.g. "remind me at 3pm tomorrow"'
                                        aria-label="Reminder natural language"
                                        className="flex-1 rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => void handleReminderParseNl()}
                                        disabled={remNlParsing || !remNlText.trim()}
                                        aria-label="Parse reminder"
                                        className="flex items-center gap-1.5 rounded-sm border border-azure/40 bg-azure/20 px-3 py-2 text-xs font-medium text-azure hover:bg-azure/30 disabled:opacity-50 transition-colors"
                                    >
                                        {remNlParsing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                        Parse
                                    </button>
                                </div>
                            </div>

                            {/* Datetime picker */}
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="reminder-datetime" className="text-xs font-medium text-text-secondary">When</label>
                                <input
                                    id="reminder-datetime"
                                    type="datetime-local"
                                    value={remDatetime}
                                    onChange={(e) => setRemDatetime(e.target.value)}
                                    aria-label="Reminder datetime"
                                    className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure focus-ring"
                                />
                                <p className="text-[11px] text-text-muted">Times are interpreted in your browser&apos;s timezone.</p>
                            </div>

                            {/* Message */}
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="reminder-message" className="text-xs font-medium text-text-secondary">Message</label>
                                <textarea
                                    id="reminder-message"
                                    value={remMessage}
                                    onChange={(e) => setRemMessage(e.target.value)}
                                    placeholder="What should Plexo say?"
                                    rows={4}
                                    maxLength={MAX_MESSAGE_LEN}
                                    aria-label="Reminder message"
                                    className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                />
                                {remMessage.length > COUNTER_THRESHOLD && (
                                    <p className={`text-[11px] ${remMessage.length >= MAX_MESSAGE_LEN ? 'text-red' : 'text-text-muted'}`}>
                                        {remMessage.length} / {MAX_MESSAGE_LEN}
                                    </p>
                                )}
                            </div>

                            {/* Channel dropdown — L4 v1: Gmail-only reminders. */}
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="reminder-channel" className="text-xs font-medium text-text-secondary">Deliver to channel</label>
                                {gmailChannels.length === 0 ? (
                                    <p className="text-xs text-text-muted" data-testid="reminder-no-channels-hint">
                                        Install a Gmail channel to set reminders.{' '}
                                        <Link href="/app/settings/channels" className="text-azure hover:underline">
                                            Add a Gmail channel
                                        </Link>
                                        .
                                    </p>
                                ) : (
                                    <select
                                        id="reminder-channel"
                                        value={remChannel}
                                        onChange={(e) => setRemChannel(e.target.value)}
                                        aria-label="Reminder channel"
                                        className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure focus-ring"
                                    >
                                        <option value="" disabled>Select a Gmail channel…</option>
                                        {gmailChannels.map((c) => {
                                            const meta = CHANNEL_META[c.type]
                                            return (
                                                <option key={c.id} value={c.id}>
                                                    {meta?.label ?? c.type} — {c.name}
                                                </option>
                                            )
                                        })}
                                    </select>
                                )}
                                <p className="text-[11px] text-text-muted">
                                    Reminders are delivered via Gmail in v1. More channel types coming soon.
                                </p>
                            </div>

                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => void handleAddReminder()}
                                    disabled={remSaving || !remDatetime || !remMessage.trim() || !remChannel}
                                    aria-label="Set reminder"
                                    className="flex items-center gap-1.5 rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors"
                                >
                                    {remSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />}
                                    {remSaving ? 'Setting…' : 'Set reminder'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Schedule panel */}
                    {activeTab === 'schedule' && (
                        <div
                            id="panel-schedule"
                            role="tabpanel"
                            aria-labelledby="tab-schedule"
                            data-testid="schedule-panel"
                            className="flex flex-col gap-4"
                        >
                            <h2 className="text-sm font-medium text-text-primary">New schedule</h2>

                            {/* NL input */}
                            <div className="flex flex-col gap-2">
                                <label className="text-xs font-medium text-text-secondary">Describe the schedule in plain English</label>
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        value={schNlText}
                                        onChange={(e) => setSchNlText(e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') void handleScheduleParseNl() }}
                                        placeholder='e.g. "every Monday at 9am"'
                                        aria-label="Schedule natural language"
                                        className="flex-1 rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => void handleScheduleParseNl()}
                                        disabled={schNlParsing || !schNlText.trim()}
                                        aria-label="Parse schedule"
                                        className="flex items-center gap-1.5 rounded-sm border border-azure/40 bg-azure/20 px-3 py-2 text-xs font-medium text-azure hover:bg-azure/30 disabled:opacity-50 transition-colors"
                                    >
                                        {schNlParsing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                        Parse
                                    </button>
                                </div>
                                {schNlParsed && (
                                    <div className="flex items-center gap-2 text-xs text-azure">
                                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                        Parsed: <code className="font-mono">{schNlParsed.cron}</code> — {schNlParsed.description}
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                <div className="flex flex-col gap-1.5">
                                    <label htmlFor="schedule-name" className="text-xs font-medium text-text-secondary">Name</label>
                                    <input
                                        id="schedule-name"
                                        type="text"
                                        value={schName}
                                        onChange={(e) => setSchName(e.target.value)}
                                        placeholder="Daily digest"
                                        aria-label="Schedule name"
                                        className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                    />
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <label htmlFor="schedule-cron" className="text-xs font-medium text-text-secondary">Cron expression</label>
                                    <input
                                        id="schedule-cron"
                                        type="text"
                                        value={schSchedule}
                                        onChange={(e) => setSchSchedule(e.target.value)}
                                        placeholder="0 9 * * 1"
                                        aria-label="Cron expression"
                                        className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                    />
                                </div>
                            </div>

                            <div className="flex flex-wrap gap-1.5">
                                {PRESETS.map((p) => (
                                    <button
                                        type="button"
                                        key={p.value}
                                        onClick={() => setSchSchedule(p.value)}
                                        className={`rounded-sm border px-2.5 py-1 text-xs transition-colors ${schSchedule === p.value
                                            ? 'border-azure/50 bg-azure/20 text-azure'
                                            : 'border-border text-text-muted hover:text-text-secondary'
                                            }`}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>

                            {/* Advanced (taskType + taskContext) */}
                            <div className="flex flex-col gap-2 border-t border-border pt-3">
                                <button
                                    type="button"
                                    onClick={() => setSchAdvancedOpen((v) => !v)}
                                    aria-expanded={schAdvancedOpen}
                                    className="self-start text-xs text-text-muted hover:text-text-secondary transition-colors"
                                >
                                    {schAdvancedOpen ? '▾' : '▸'} Advanced
                                </button>
                                {schAdvancedOpen && (
                                    <div className="flex flex-col gap-3">
                                        <div className="flex flex-col gap-1.5">
                                            <label htmlFor="schedule-tasktype" className="text-xs font-medium text-text-secondary">Task type</label>
                                            <select
                                                id="schedule-tasktype"
                                                value={schTaskType}
                                                onChange={(e) => setSchTaskType(e.target.value)}
                                                aria-label="Task type"
                                                className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure focus-ring"
                                            >
                                                <option value="">Default</option>
                                                {TASK_TYPES.map((t) => (
                                                    <option key={t} value={t}>{t}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className="flex flex-col gap-1.5">
                                            <label htmlFor="schedule-context" className="text-xs font-medium text-text-secondary">Task context (JSON)</label>
                                            <textarea
                                                id="schedule-context"
                                                value={schTaskContextJson}
                                                onChange={(e) => setSchTaskContextJson(e.target.value)}
                                                placeholder='{"channel": "...", "message": "..."}'
                                                rows={4}
                                                aria-label="Task context JSON"
                                                className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-xs font-mono text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    onClick={() => void handleAddSchedule()}
                                    disabled={schSaving || !schName.trim() || !schSchedule.trim()}
                                    aria-label="Save schedule"
                                    className="flex items-center gap-1.5 rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors"
                                >
                                    {schSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                    {schSaving ? 'Saving…' : 'Schedule'}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Search + filter toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search by name…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                ]}
            />

            {loading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : (
                <>
                    {/* Reminders section */}
                    <section className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <Bell className="h-4 w-4 text-text-muted" />
                            <h2 className="text-sm font-medium text-text-secondary">Reminders</h2>
                            <span className="text-xs text-text-muted">({partitioned.reminders.length})</span>
                        </div>
                        {partitioned.reminders.length === 0 ? (
                            <div className="rounded-sm border border-border bg-surface-1/40 p-8 text-center">
                                <p className="text-sm text-text-muted">No reminders yet. Set one up in the form above.</p>
                            </div>
                        ) : (
                            <div className="grid gap-2">
                                {partitioned.reminders.map((job) => (
                                    <ReminderCard
                                        key={job.id}
                                        job={job}
                                        channels={channels}
                                        triggering={triggering === job.id}
                                        toggling={toggling === job.id}
                                        deleting={deleting === job.id}
                                        onTrigger={() => void handleTrigger(job)}
                                        onToggle={() => void handleToggle(job)}
                                        onDelete={() => void handleDelete(job.id)}
                                    />
                                ))}
                            </div>
                        )}
                    </section>

                    {/* Schedules section */}
                    <section className="flex flex-col gap-3">
                        <div className="flex items-center gap-2">
                            <Clock className="h-4 w-4 text-text-muted" />
                            <h2 className="text-sm font-medium text-text-secondary">Schedules</h2>
                            <span className="text-xs text-text-muted">({partitioned.schedules.length})</span>
                        </div>
                        {partitioned.schedules.length === 0 ? (
                            <div className="rounded-sm border border-border bg-surface-1/40 p-8 text-center">
                                <Clock className="h-8 w-8 text-text-muted mx-auto mb-2" />
                                <p className="text-sm font-medium text-text-secondary">No schedules configured</p>
                                <p className="text-xs text-text-muted mt-1">Schedule recurring tasks for your agent.</p>
                            </div>
                        ) : (
                            <div className="rounded-sm border border-border bg-surface-1/40 overflow-hidden overflow-x-auto">
                                <table className="w-full min-w-[600px]">
                                    <thead className="border-b border-border">
                                        <tr>
                                            {['Name', 'Schedule', 'Type', 'Last run', 'Status', ''].map((h) => (
                                                <th key={h} className="px-4 py-3 text-left text-xs font-medium text-text-muted">{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {partitioned.schedules.map((job) => (
                                            <tr key={job.id} className="border-b border-border-subtle hover:bg-surface-2/20 transition-colors">
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-2">
                                                        <div className={`h-2 w-2 rounded-full shrink-0 ${job.enabled ? 'bg-azure' : 'bg-surface-3'}`} />
                                                        <span className="text-sm font-medium text-text-primary">{job.name}</span>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 font-mono text-xs text-text-secondary">{job.schedule}</td>
                                                <td className="px-4 py-3 text-xs text-text-muted">{job.taskType ?? '—'}</td>
                                                <td className="px-4 py-3 text-xs text-text-muted">
                                                    {job.lastRunAt ? timeAgo(job.lastRunAt) : '—'}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <StatusIcon status={job.lastRunStatus} />
                                                    {job.consecutiveFailures > 0 && (
                                                        <span className="ml-1.5 inline-flex items-center gap-1 text-xs text-red">
                                                            <AlertCircle className="h-3 w-3" />
                                                            {job.consecutiveFailures}
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3">
                                                    <div className="flex items-center gap-1.5 justify-end">
                                                        <button
                                                            onClick={() => void handleTrigger(job)}
                                                            disabled={triggering === job.id}
                                                            title="Manual trigger"
                                                            aria-label={`Run ${job.name} now`}
                                                            className="rounded p-1.5 text-text-muted hover:text-azure transition-colors"
                                                        >
                                                            {triggering === job.id
                                                                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                                                : <Play className="h-3.5 w-3.5" />}
                                                        </button>
                                                        <button
                                                            onClick={() => void handleToggle(job)}
                                                            disabled={toggling === job.id}
                                                            title={job.enabled ? 'Disable' : 'Enable'}
                                                            aria-label={job.enabled ? `Disable ${job.name}` : `Enable ${job.name}`}
                                                            className="rounded p-1.5 text-text-muted hover:text-text-secondary transition-colors"
                                                        >
                                                            {toggling === job.id
                                                                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                                                : job.enabled
                                                                    ? <ToggleRight className="h-4 w-4 text-azure" />
                                                                    : <ToggleLeft className="h-4 w-4" />}
                                                        </button>
                                                        <button
                                                            onClick={() => void handleDelete(job.id)}
                                                            disabled={deleting === job.id}
                                                            title="Delete"
                                                            aria-label={`Delete ${job.name}`}
                                                            className="rounded p-1.5 text-text-muted hover:text-red transition-colors"
                                                        >
                                                            {deleting === job.id
                                                                ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                                                : <Trash2 className="h-3.5 w-3.5" />}
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                </>
            )}

            {totalCount === 0 && !loading && !adding && (
                <p className="text-center text-xs text-text-muted">Plexo will route reminders through the channel you pick.</p>
            )}
        </div>
    )
}

// ── Reminder card ────────────────────────────────────────────────────────────

function ReminderCard({
    job,
    channels,
    triggering,
    toggling,
    deleting,
    onTrigger,
    onToggle,
    onDelete,
}: {
    job: CronJob
    channels: Channel[]
    triggering: boolean
    toggling: boolean
    deleting: boolean
    onTrigger: () => void
    onToggle: () => void
    onDelete: () => void
}) {
    const ctx = (job.taskContext ?? {}) as { channel?: string; channelId?: string; message?: string }
    // Post-fix rows store channelId (uuid) + channel (type). Pre-fix rows
    // stored channel=<uuid>; tolerate that legacy shape for display.
    const linkedChannelId = ctx.channelId ?? (ctx.channel && /^[0-9a-f-]{36}$/i.test(ctx.channel) ? ctx.channel : undefined)
    const linkedChannel = linkedChannelId ? channels.find((c) => c.id === linkedChannelId) : undefined
    const ChannelIcon = linkedChannel ? CHANNEL_META[linkedChannel.type]?.icon ?? Webhook : Webhook
    const channelLabel = linkedChannel
        ? `${CHANNEL_META[linkedChannel.type]?.label ?? linkedChannel.type} — ${linkedChannel.name}`
        : linkedChannelId
            ? `Channel ${String(linkedChannelId).slice(0, 8)}…`
            : 'No channel'
    const messagePreview = (ctx.message ?? '').slice(0, 60) + ((ctx.message ?? '').length > 60 ? '…' : '')

    return (
        <div className="rounded-sm border border-border bg-surface-1/40 p-3 flex items-center gap-3 hover:bg-surface-2/20 transition-colors">
            <div className={`h-2 w-2 rounded-full shrink-0 ${job.enabled ? 'bg-azure' : 'bg-surface-3'}`} />
            <Bell className="h-4 w-4 text-text-muted shrink-0" />
            <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-text-primary truncate">{job.name}</span>
                    {job.scheduleAt && (
                        <span className="text-xs text-text-muted shrink-0" title={formatAbsolute(job.scheduleAt)}>
                            {relativeFuture(job.scheduleAt)} · {formatAbsolute(job.scheduleAt)}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2 text-xs text-text-muted">
                    <span className="flex items-center gap-1">
                        <ChannelIcon className="h-3 w-3" />
                        {channelLabel}
                    </span>
                    {messagePreview && <span className="truncate">· {messagePreview}</span>}
                </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
                <button
                    onClick={onTrigger}
                    disabled={triggering}
                    title="Send now"
                    aria-label={`Send ${job.name} now`}
                    className="rounded p-1.5 text-text-muted hover:text-azure transition-colors"
                >
                    {triggering ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                </button>
                <button
                    onClick={onToggle}
                    disabled={toggling}
                    title={job.enabled ? 'Disable' : 'Enable'}
                    aria-label={job.enabled ? `Disable ${job.name}` : `Enable ${job.name}`}
                    className="rounded p-1.5 text-text-muted hover:text-text-secondary transition-colors"
                >
                    {toggling
                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                        : job.enabled
                            ? <ToggleRight className="h-4 w-4 text-azure" />
                            : <ToggleLeft className="h-4 w-4" />}
                </button>
                <button
                    onClick={onDelete}
                    disabled={deleting}
                    title="Delete"
                    aria-label={`Delete ${job.name}`}
                    className="rounded p-1.5 text-text-muted hover:text-red transition-colors"
                >
                    {deleting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
            </div>
        </div>
    )
}
