// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

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
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ─────────────────────────────────────────────────────────────────────

interface CronJob {
    id: string
    name: string
    schedule: string
    enabled: boolean
    lastRunAt: string | null
    lastRunStatus: 'success' | 'failure' | null
    consecutiveFailures: number
    createdAt: string
}

// ── Config ────────────────────────────────────────────────────────────────────

const PRESETS = [
    { label: 'Every 5 minutes', value: '*/5 * * * *' },
    { label: 'Every 15 minutes', value: '*/15 * * * *' },
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Every 6 hours', value: '0 */6 * * *' },
    { label: 'Daily at midnight', value: '0 0 * * *' },
    { label: 'Weekly (Mon 9am)', value: '0 9 * * 1' },
]

// Module-level constant for useListFilter initialiser
const FILTER_KEYS = ['enabled'] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

function StatusIcon({ status }: { status: CronJob['lastRunStatus'] }) {
    if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-azure" />
    if (status === 'failure') return <XCircle className="h-4 w-4 text-red" />
    return <Clock className="h-4 w-4 text-text-muted" />
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function CronPage() {
    const { workspaceId } = useWorkspace()
    const WS_ID = workspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const [jobs, setJobs] = useState<CronJob[]>([])
    const [loading, setLoading] = useState(true)
    const [adding, setAdding] = useState(false)
    const [newName, setNewName] = useState('')
    const [newSchedule, setNewSchedule] = useState('')
    const [nlText, setNlText] = useState('')
    const [nlParsed, setNlParsed] = useState<{ cron: string; description: string } | null>(null)
    const [nlParsing, setNlParsing] = useState(false)
    const [saving, setSaving] = useState(false)
    const [triggering, setTriggering] = useState<string | null>(null)
    const [toggling, setToggling] = useState<string | null>(null)
    const [deleting, setDeleting] = useState<string | null>(null)
    const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

    // ── Filter state (shared standard) ────────────────────────────────────────
    const lf = useListFilter(FILTER_KEYS, 'newest')
    const { search, filterValues, hasFilters } = lf

    // ── Data loading ──────────────────────────────────────────────────────────
    const fetchJobs = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/cron?workspaceId=${WS_ID}`)
            if (res.ok) {
                const data = await res.json() as { items: CronJob[] }
                setJobs(data.items ?? [])
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

    // ── Client-side filtering ─────────────────────────────────────────────────
    const displayed = useMemo(() => {
        const q = search.trim().toLowerCase()
        let result = jobs.filter((job) => {
            if (filterValues.enabled === 'true' && !job.enabled) return false
            if (filterValues.enabled === 'false' && job.enabled) return false
            if (q) {
                return (
                    job.name.toLowerCase().includes(q) ||
                    job.schedule.toLowerCase().includes(q)
                )
            }
            return true
        })

        result = [...result].sort((a, b) => {
            if (lf.sort === 'oldest') {
                return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            }
            if (lf.sort === 'name_asc') {
                return a.name.localeCompare(b.name)
            }
            if (lf.sort === 'name_desc') {
                return b.name.localeCompare(a.name)
            }
            if (lf.sort === 'enabled_first') {
                return (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0)
            }
            if (lf.sort === 'disabled_first') {
                return (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0)
            }
            if (lf.sort === 'failures_desc') {
                return b.consecutiveFailures - a.consecutiveFailures
            }
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        })

        return result
    }, [jobs, search, filterValues.enabled, lf.sort])

    // ── Mutations ─────────────────────────────────────────────────────────────

    async function handleParseNl() {
        if (!nlText.trim()) return
        setNlParsing(true)
        setNlParsed(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/cron/parse-nl`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: nlText }),
            })
            if (res.ok) {
                const d = await res.json() as { cron: string; description: string }
                setNlParsed(d)
                setNewSchedule(d.cron)
            } else {
                setNlParsed(null)
                setMessage({ ok: false, text: 'Could not parse that schedule — try e.g. "every day at 9am"' })
            }
        } finally {
            setNlParsing(false)
        }
    }

    async function handleAdd() {
        if (!newName.trim() || !newSchedule.trim()) return
        setSaving(true)
        setMessage(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/cron`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, name: newName, schedule: newSchedule }),
            })
            if (res.ok) {
                setMessage({ ok: true, text: `${newName} scheduled` })
                setAdding(false)
                setNewName('')
                setNewSchedule('')
                void fetchJobs()
            } else {
                const err = await res.json() as { error?: { message?: string } }
                setMessage({ ok: false, text: err.error?.message ?? 'Failed' })
            }
        } finally {
            setSaving(false)
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

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Scheduled Jobs</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        {loading
                            ? '…'
                            : `${displayed.length}${displayed.length !== jobs.length ? ` of ${jobs.length}` : ''} job${jobs.length === 1 ? '' : 's'}`}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void fetchJobs()}
                        disabled={loading}
                        className="rounded-lg border border-border bg-surface-1 p-2 text-text-muted hover:text-text-secondary transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => setAdding(true)}
                        className="flex items-center gap-1.5 rounded-lg bg-azure px-3 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add job
                    </button>
                </div>
            </div>

            {message && (
                <div className={`rounded-lg border px-3 py-2.5 text-sm ${message.ok ? 'border-azure/30 bg-azure/30 text-azure' : 'border-red-800/50 bg-red-950/30 text-red'}`}>
                    {message.text}
                </div>
            )}

            {/* Add form */}
            {adding && (
                <div className="rounded-xl border border-azure/30 bg-surface-1/60 p-4 flex flex-col gap-4">
                    <h2 className="text-sm font-semibold text-text-primary">New scheduled job</h2>

                    <div className="flex flex-col gap-2">
                        <label className="text-xs font-medium text-text-secondary">Describe the schedule in plain English</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={nlText}
                                onChange={(e) => setNlText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void handleParseNl() }}
                                placeholder='e.g. "every Monday at 9am" or "daily at midnight"'
                                className="flex-1 rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                            />
                            <button
                                onClick={() => void handleParseNl()}
                                disabled={nlParsing || !nlText.trim()}
                                className="flex items-center gap-1.5 rounded-lg border border-azure/40 bg-azure/20 px-3 py-2 text-xs font-medium text-azure hover:bg-azure/30 disabled:opacity-50 transition-colors"
                            >
                                {nlParsing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                Parse
                            </button>
                        </div>
                        {nlParsed && (
                            <div className="flex items-center gap-2 text-xs text-azure">
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                Parsed: <code className="font-mono">{nlParsed.cron}</code> — {nlParsed.description}
                            </div>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-medium text-text-secondary">Job name</label>
                            <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="Daily digest"
                                className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                            />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-medium text-text-secondary">Cron expression</label>
                            <input
                                type="text"
                                value={newSchedule}
                                onChange={(e) => setNewSchedule(e.target.value)}
                                placeholder="0 9 * * 1"
                                className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm font-mono text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                            />
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                        {PRESETS.map((p) => (
                            <button
                                key={p.value}
                                onClick={() => setNewSchedule(p.value)}
                                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${newSchedule === p.value
                                    ? 'border-azure/50 bg-azure/20 text-azure'
                                    : 'border-border text-text-muted hover:text-text-secondary'
                                    }`}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>

                    <div className="flex gap-2">
                        <button
                            onClick={() => void handleAdd()}
                            disabled={saving || !newName.trim() || !newSchedule.trim()}
                            className="flex items-center gap-1.5 rounded-lg bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors"
                        >
                            {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                            {saving ? 'Saving…' : 'Schedule'}
                        </button>
                        <button
                            onClick={() => { setAdding(false); setMessage(null) }}
                            className="rounded-lg border border-border px-3 py-2 text-sm text-text-muted hover:text-text-secondary transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Search + filter toolbar */}
            <ListToolbar
                hook={lf}
                placeholder="Search by name or schedule…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Newest first', value: 'newest' },
                    { label: 'Oldest first', value: 'oldest' },
                    { label: 'Name: A → Z', value: 'name_asc' },
                    { label: 'Name: Z → A', value: 'name_desc' },
                    { label: 'Enabled first', value: 'enabled_first' },
                    { label: 'Disabled first', value: 'disabled_first' },
                    { label: 'Most failures', value: 'failures_desc' },
                ]}
            />

            {/* Job table */}
            {loading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : jobs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 rounded-xl border border-dashed border-border">
                    <Clock className="h-8 w-8 text-zinc-700" />
                    <p className="text-sm text-text-muted">No scheduled jobs — add one above</p>
                </div>
            ) : displayed.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-1/40 py-12 text-center">
                    <p className="text-sm text-text-muted">No jobs match your filters</p>
                    <button
                        onClick={lf.clearAll}
                        className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors mx-auto"
                    >
                        Clear filters
                    </button>
                </div>
            ) : (
                <div className="rounded-xl border border-border bg-surface-1/40 overflow-hidden">
                    <table className="w-full">
                        <thead className="border-b border-border">
                            <tr>
                                {['Name', 'Schedule', 'Last run', 'Status', 'Failures', ''].map((h) => (
                                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-text-muted">{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {displayed.map((job) => (
                                <tr key={job.id} className="border-b border-border-subtle hover:bg-surface-2/20 transition-colors">
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-2">
                                            <div className={`h-2 w-2 rounded-full shrink-0 ${job.enabled ? 'bg-azure' : 'bg-surface-3'}`} />
                                            <span className="text-sm font-medium text-text-primary">{job.name}</span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 font-mono text-xs text-text-secondary">{job.schedule}</td>
                                    <td className="px-4 py-3 text-xs text-text-muted">
                                        {job.lastRunAt ? timeAgo(job.lastRunAt) : '—'}
                                    </td>
                                    <td className="px-4 py-3">
                                        <StatusIcon status={job.lastRunStatus} />
                                    </td>
                                    <td className="px-4 py-3">
                                        {job.consecutiveFailures > 0 ? (
                                            <span className="flex items-center gap-1 text-xs text-red">
                                                <AlertCircle className="h-3.5 w-3.5" />
                                                {job.consecutiveFailures}
                                            </span>
                                        ) : (
                                            <span className="text-xs text-zinc-700">—</span>
                                        )}
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-1.5 justify-end">
                                            <button
                                                onClick={() => void handleTrigger(job)}
                                                disabled={triggering === job.id}
                                                title="Manual trigger"
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
                                                className="rounded p-1.5 text-zinc-700 hover:text-red transition-colors"
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
        </div>
    )
}
