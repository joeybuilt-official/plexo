'use client'

import { useState, useEffect, useCallback } from 'react'
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

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

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

// ── Cron expression presets ───────────────────────────────────────────────────

const PRESETS = [
    { label: 'Every 5 minutes', value: '*/5 * * * *' },
    { label: 'Every 15 minutes', value: '*/15 * * * *' },
    { label: 'Every hour', value: '0 * * * *' },
    { label: 'Every 6 hours', value: '0 */6 * * *' },
    { label: 'Daily at midnight', value: '0 0 * * *' },
    { label: 'Weekly (Mon 9am)', value: '0 9 * * 1' },
]

function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

function StatusIcon({ status }: { status: CronJob['lastRunStatus'] }) {
    if (status === 'success') return <CheckCircle2 className="h-4 w-4 text-emerald-400" />
    if (status === 'failure') return <XCircle className="h-4 w-4 text-red-400" />
    return <Clock className="h-4 w-4 text-zinc-600" />
}

// ── Main page ─────────────────────────────────────────────────────────────────

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

    const fetchJobs = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        try {
            const res = await fetch(`${API_BASE}/api/cron?workspaceId=${WS_ID}`)
            if (res.ok) {
                const data = await res.json() as { items: CronJob[] }
                setJobs(data.items ?? [])
            }
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void fetchJobs() }, [fetchJobs])

    async function handleParseNl() {
        if (!nlText.trim()) return
        setNlParsing(true)
        setNlParsed(null)
        try {
            const res = await fetch(`${API_BASE}/api/cron/parse-nl`, {
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
            const res = await fetch(`${API_BASE}/api/cron`, {
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
            await fetch(`${API_BASE}/api/cron/${job.id}`, {
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
            const res = await fetch(`${API_BASE}/api/cron/${job.id}/trigger`, {
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
            await fetch(`${API_BASE}/api/cron/${id}?workspaceId=${WS_ID}`, { method: 'DELETE' })
            setJobs((p) => p.filter((j) => j.id !== id))
        } finally {
            setDeleting(null)
        }
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Scheduled Jobs</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">
                        Recurring tasks the agent runs on a cron schedule.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => void fetchJobs()}
                        disabled={loading}
                        className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={() => setAdding(true)}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add job
                    </button>
                </div>
            </div>

            {message && (
                <div className={`rounded-lg border px-3 py-2.5 text-sm ${message.ok ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-400' : 'border-red-800/50 bg-red-950/30 text-red-400'}`}>
                    {message.text}
                </div>
            )}

            {/* Add form */}
            {adding && (
                <div className="rounded-xl border border-indigo-500/30 bg-zinc-900/60 p-4 flex flex-col gap-4">
                    <h2 className="text-sm font-semibold text-zinc-200">New scheduled job</h2>

                    {/* NLP schedule builder */}
                    <div className="flex flex-col gap-2">
                        <label className="text-xs font-medium text-zinc-400">Describe the schedule in plain English</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={nlText}
                                onChange={(e) => setNlText(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void handleParseNl() }}
                                placeholder='e.g. "every Monday at 9am" or "daily at midnight"'
                                className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                            />
                            <button
                                onClick={() => void handleParseNl()}
                                disabled={nlParsing || !nlText.trim()}
                                className="flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-600/20 px-3 py-2 text-xs font-medium text-indigo-300 hover:bg-indigo-600/30 disabled:opacity-50 transition-colors"
                            >
                                {nlParsing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                                Parse
                            </button>
                        </div>
                        {nlParsed && (
                            <div className="flex items-center gap-2 text-xs text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                                Parsed: <code className="font-mono">{nlParsed.cron}</code> — {nlParsed.description}
                            </div>
                        )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-medium text-zinc-400">Job name</label>
                            <input
                                type="text"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                placeholder="Daily digest"
                                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                            />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-medium text-zinc-400">Cron expression</label>
                            <input
                                type="text"
                                value={newSchedule}
                                onChange={(e) => setNewSchedule(e.target.value)}
                                placeholder="0 9 * * 1"
                                className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-mono text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                            />
                        </div>
                    </div>
                    {/* Presets */}
                    <div className="flex flex-wrap gap-1.5">
                        {PRESETS.map((p) => (
                            <button
                                key={p.value}
                                onClick={() => setNewSchedule(p.value)}
                                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${newSchedule === p.value
                                    ? 'border-indigo-500/50 bg-indigo-600/20 text-indigo-300'
                                    : 'border-zinc-800 text-zinc-500 hover:text-zinc-300'
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
                            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                        >
                            {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                            {saving ? 'Saving…' : 'Schedule'}
                        </button>
                        <button
                            onClick={() => { setAdding(false); setMessage(null) }}
                            className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Job table */}
            {loading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-zinc-600">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
                </div>
            ) : jobs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 rounded-xl border border-dashed border-zinc-800">
                    <Clock className="h-8 w-8 text-zinc-700" />
                    <p className="text-sm text-zinc-600">No scheduled jobs — add one above</p>
                </div>
            ) : (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                    <table className="w-full">
                        <thead className="border-b border-zinc-800">
                            <tr>
                                {['Name', 'Schedule', 'Last run', 'Status', 'Failures', ''].map((h) => (
                                    <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-zinc-600">{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {jobs.map((job) => (
                                <tr key={job.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/20 transition-colors">
                                    <td className="px-4 py-3">
                                        <div className="flex items-center gap-2">
                                            <div className={`h-2 w-2 rounded-full shrink-0 ${job.enabled ? 'bg-emerald-500' : 'bg-zinc-600'}`} />
                                            <span className="text-sm font-medium text-zinc-200">{job.name}</span>
                                        </div>
                                    </td>
                                    <td className="px-4 py-3 font-mono text-xs text-zinc-400">{job.schedule}</td>
                                    <td className="px-4 py-3 text-xs text-zinc-500">
                                        {job.lastRunAt ? timeAgo(job.lastRunAt) : '—'}
                                    </td>
                                    <td className="px-4 py-3">
                                        <StatusIcon status={job.lastRunStatus} />
                                    </td>
                                    <td className="px-4 py-3">
                                        {job.consecutiveFailures > 0 ? (
                                            <span className="flex items-center gap-1 text-xs text-red-400">
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
                                                className="rounded p-1.5 text-zinc-600 hover:text-indigo-400 transition-colors"
                                            >
                                                {triggering === job.id
                                                    ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                                    : <Play className="h-3.5 w-3.5" />
                                                }
                                            </button>
                                            <button
                                                onClick={() => void handleToggle(job)}
                                                disabled={toggling === job.id}
                                                title={job.enabled ? 'Disable' : 'Enable'}
                                                className="rounded p-1.5 text-zinc-600 hover:text-zinc-300 transition-colors"
                                            >
                                                {toggling === job.id
                                                    ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                                    : job.enabled
                                                        ? <ToggleRight className="h-4 w-4 text-emerald-400" />
                                                        : <ToggleLeft className="h-4 w-4" />
                                                }
                                            </button>
                                            <button
                                                onClick={() => void handleDelete(job.id)}
                                                disabled={deleting === job.id}
                                                title="Delete"
                                                className="rounded p-1.5 text-zinc-700 hover:text-red-400 transition-colors"
                                            >
                                                {deleting === job.id
                                                    ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                                    : <Trash2 className="h-3.5 w-3.5" />
                                                }
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
