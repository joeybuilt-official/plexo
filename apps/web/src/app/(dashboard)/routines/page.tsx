// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useState, useCallback } from 'react'
import { Calendar, CheckCircle, AlertTriangle, Pencil, Trash2 } from 'lucide-react'

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL ?? 'http://localhost:3001')

interface Routine {
    id: string
    name: string
    schedule: string | null
    enabled: boolean
    taskType: string
    prompt: string | null
    repoUrl: string | null
    branchRef: string
    connectorIds: string[]
    notifyChannel: string | null
    nextRunAt: string | null
    lastRunAt: string | null
    lastRunStatus: 'success' | 'failure' | null
    consecutiveFailures: number
}

type TaskType = 'general' | 'code' | 'ops' | 'research' | 'writing'

const TASK_TYPES: TaskType[] = ['general', 'code', 'ops', 'research', 'writing']

function formatNextRun(iso: string | null): string {
    if (!iso) return '—'
    const d = new Date(iso)
    const now = Date.now()
    const diff = d.getTime() - now
    if (Math.abs(diff) > 7 * 24 * 60 * 60 * 1000) return d.toISOString().slice(0, 16).replace('T', ' ')
    const abs = Math.abs(diff)
    const mins = Math.floor(abs / 60000)
    const hours = Math.floor(mins / 60)
    const days = Math.floor(hours / 24)
    if (days > 0) return `in ${days}d`
    if (hours > 0) return `in ${hours}h`
    if (mins > 0) return `in ${mins}m`
    return 'soon'
}

function LastRunBadge({ status }: { status: 'success' | 'failure' | null }) {
    if (status === 'success') {
        return (
            <span className="inline-flex items-center gap-1 rounded-sm bg-green-900/30 px-1.5 py-0.5 text-[11px] font-medium text-green-400">
                <CheckCircle className="h-3 w-3" /> ok
            </span>
        )
    }
    if (status === 'failure') {
        return (
            <span className="inline-flex items-center gap-1 rounded-sm bg-red-900/30 px-1.5 py-0.5 text-[11px] font-medium text-red-400">
                <AlertTriangle className="h-3 w-3" /> failed
            </span>
        )
    }
    return (
        <span className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-text-muted">
            — never
        </span>
    )
}

const EMPTY_FORM = {
    name: '',
    schedule: '',
    prompt: '',
    repoUrl: '',
    branchRef: 'main',
    notifyChannel: '',
    taskType: 'general' as TaskType,
}

export default function RoutinesPage() {
    const [routines, setRoutines] = useState<Routine[]>([])
    const [loading, setLoading] = useState(true)
    const [creating, setCreating] = useState(false)
    const [editing, setEditing] = useState<Routine | null>(null)
    const [saving, setSaving] = useState(false)
    const [wsId, setWsId] = useState('')

    const [form, setForm] = useState({ ...EMPTY_FORM })
    const [scheduleDesc, setScheduleDesc] = useState<string | null>(null)
    const [scheduleErr, setScheduleErr] = useState(false)

    const load = useCallback((workspaceId: string) => {
        setLoading(true)
        fetch(`${API_BASE}/api/cron?workspaceId=${encodeURIComponent(workspaceId)}&type=schedule`)
            .then(r => r.ok ? r.json() : [])
            .then((data: Routine[]) => setRoutines(Array.isArray(data) ? data : []))
            .catch(() => setRoutines([]))
            .finally(() => setLoading(false))
    }, [])

    useEffect(() => {
        const id = localStorage.getItem('plexo_workspace_id') ?? ''
        setWsId(id)
        if (!id) { setLoading(false); return }
        load(id)
    }, [load])

    function openCreate() {
        setEditing(null)
        setForm({ ...EMPTY_FORM })
        setScheduleDesc(null)
        setScheduleErr(false)
        setCreating(true)
    }

    function openEdit(r: Routine) {
        setCreating(false)
        setForm({
            name: r.name,
            schedule: r.schedule ?? '',
            prompt: r.prompt ?? '',
            repoUrl: r.repoUrl ?? '',
            branchRef: r.branchRef ?? 'main',
            notifyChannel: r.notifyChannel ?? '',
            taskType: (r.taskType as TaskType) ?? 'general',
        })
        setScheduleDesc(null)
        setScheduleErr(false)
        setEditing(r)
    }

    function closeForm() {
        setCreating(false)
        setEditing(null)
    }

    async function parseSchedule(text: string) {
        if (!text.trim()) { setScheduleDesc(null); setScheduleErr(false); return }
        try {
            const res = await fetch(`${API_BASE}/api/cron/parse-nl`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text }),
            })
            if (res.status === 422) { setScheduleErr(true); setScheduleDesc(null); return }
            if (res.ok) {
                const data = await res.json() as { cron?: string; scheduleAt?: string; description: string }
                setScheduleErr(false)
                setScheduleDesc(data.description)
                if (data.cron) setForm(f => ({ ...f, schedule: data.cron! }))
            }
        } catch {
            setScheduleErr(false)
        }
    }

    async function toggleEnabled(r: Routine) {
        // Optimistic update
        setRoutines(prev => prev.map(x => x.id === r.id ? { ...x, enabled: !x.enabled } : x))
        try {
            const res = await fetch(`${API_BASE}/api/cron/${r.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: wsId, enabled: !r.enabled }),
            })
            if (!res.ok) {
                // Revert on failure
                setRoutines(prev => prev.map(x => x.id === r.id ? { ...x, enabled: r.enabled } : x))
            }
        } catch {
            setRoutines(prev => prev.map(x => x.id === r.id ? { ...x, enabled: r.enabled } : x))
        }
    }

    async function deleteRoutine(r: Routine) {
        if (!window.confirm(`Delete routine "${r.name}"?`)) return
        const res = await fetch(`${API_BASE}/api/cron/${r.id}?workspaceId=${encodeURIComponent(wsId)}`, {
            method: 'DELETE',
        })
        if (res.ok) setRoutines(prev => prev.filter(x => x.id !== r.id))
    }

    async function save() {
        if (!form.name.trim()) return
        setSaving(true)
        const body: Record<string, string | boolean | null> = {
            workspaceId: wsId,
            name: form.name.trim(),
            schedule: form.schedule.trim() || null,
            taskType: form.taskType,
            prompt: form.prompt.trim() || null,
            repoUrl: form.repoUrl.trim() || null,
            branchRef: form.branchRef.trim() || 'main',
            notifyChannel: form.notifyChannel.trim() || null,
        }
        try {
            let res: Response
            if (editing) {
                res = await fetch(`${API_BASE}/api/cron/${editing.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
            } else {
                res = await fetch(`${API_BASE}/api/cron`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
            }
            if (res.ok) {
                closeForm()
                load(wsId)
            }
        } finally {
            setSaving(false)
        }
    }

    const showForm = creating || editing !== null

    return (
        <div className="p-6 max-w-5xl mx-auto space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-semibold text-text-primary flex items-center gap-2">
                    <Calendar className="h-6 w-6 text-azure" />
                    Routines
                </h1>
                <button
                    onClick={openCreate}
                    className="rounded-md bg-azure px-3 py-1.5 text-sm font-medium text-white hover:bg-azure/90 transition-colors"
                >
                    New routine
                </button>
            </div>

            {loading ? (
                <div className="space-y-2">
                    {[0, 1, 2].map(i => (
                        <div key={i} className="rounded-lg border border-border bg-surface-1/40 p-3 animate-pulse h-16" />
                    ))}
                </div>
            ) : routines.length === 0 && !showForm ? (
                <div className="flex flex-col items-center justify-center rounded border border-dashed border-border bg-surface-1/20 p-16 text-center space-y-3">
                    <Calendar className="h-12 w-12 text-text-muted/40" />
                    <h3 className="text-base font-medium text-text-secondary">No routines yet</h3>
                    <p className="text-sm text-text-muted max-w-sm">
                        Routines let your agent run scheduled tasks automatically — daily summaries, weekly reports, recurring ops checks.
                    </p>
                    <button
                        onClick={openCreate}
                        className="rounded-md bg-azure px-3 py-1.5 text-sm font-medium text-white hover:bg-azure/90 transition-colors"
                    >
                        Create your first routine
                    </button>
                </div>
            ) : (
                <div className="space-y-2">
                    {routines.map(r => (
                        <div key={r.id} className="rounded-lg border border-border bg-surface-1 p-3 flex items-center gap-3">
                            {/* Toggle */}
                            <button
                                onClick={() => void toggleEnabled(r)}
                                aria-label={r.enabled ? 'Disable routine' : 'Enable routine'}
                                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${r.enabled ? 'bg-azure' : 'bg-border'}`}
                            >
                                <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${r.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                            </button>

                            {/* Info */}
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-semibold text-sm text-text-primary truncate">{r.name}</span>
                                    <span className="text-xs text-text-muted shrink-0">
                                        {r.schedule ?? 'One-shot'}
                                    </span>
                                </div>
                                <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                                    <span className="text-xs text-text-muted">
                                        Next: {formatNextRun(r.nextRunAt)}
                                    </span>
                                    <LastRunBadge status={r.lastRunStatus} />
                                    {r.consecutiveFailures > 0 && (
                                        <span className="text-xs text-red-400">{r.consecutiveFailures} consecutive failure{r.consecutiveFailures !== 1 ? 's' : ''}</span>
                                    )}
                                </div>
                            </div>

                            {/* Actions */}
                            <div className="flex items-center gap-1 shrink-0">
                                <button
                                    onClick={() => openEdit(r)}
                                    aria-label="Edit routine"
                                    className="rounded p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
                                >
                                    <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    onClick={() => void deleteRoutine(r)}
                                    aria-label="Delete routine"
                                    className="rounded p-1.5 text-text-muted hover:text-red-400 hover:bg-red-900/20 transition-colors"
                                >
                                    <Trash2 className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {/* Create / edit form */}
            {showForm && (
                <div className="rounded-lg border border-border bg-surface-1 p-4 space-y-4">
                    <h2 className="text-sm font-semibold text-text-primary">
                        {editing ? 'Edit routine' : 'New routine'}
                    </h2>

                    {/* Name */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-text-secondary">Name *</label>
                        <input
                            type="text"
                            value={form.name}
                            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                            placeholder="Daily standup summary"
                            className="w-full rounded-lg border border-border bg-surface-1 p-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                        />
                    </div>

                    {/* Schedule */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-text-secondary">Schedule</label>
                        <input
                            type="text"
                            value={form.schedule}
                            onChange={e => { setForm(f => ({ ...f, schedule: e.target.value })); setScheduleDesc(null); setScheduleErr(false) }}
                            onBlur={e => void parseSchedule(e.target.value)}
                            placeholder="every day at 9am, 0 9 * * *, …"
                            className="w-full rounded-lg border border-border bg-surface-1 p-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                        />
                        {scheduleErr && (
                            <p className="text-xs text-red-400">Could not parse schedule</p>
                        )}
                        {scheduleDesc && !scheduleErr && (
                            <p className="text-xs text-text-muted">{scheduleDesc}</p>
                        )}
                        <p className="text-xs text-text-muted">Leave blank for a one-shot run.</p>
                    </div>

                    {/* Task type */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-text-secondary">Task type</label>
                        <select
                            value={form.taskType}
                            onChange={e => setForm(f => ({ ...f, taskType: e.target.value as TaskType }))}
                            className="w-full rounded-lg border border-border bg-surface-1 p-3 text-sm text-text-primary focus:border-azure focus:outline-none"
                        >
                            {TASK_TYPES.map(t => (
                                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                            ))}
                        </select>
                    </div>

                    {/* Prompt */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-text-secondary">Prompt</label>
                        <textarea
                            value={form.prompt}
                            onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
                            placeholder="Describe what the agent should do each run…"
                            rows={3}
                            className="w-full rounded-lg border border-border bg-surface-1 p-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none resize-y"
                        />
                    </div>

                    {/* Repo URL */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-text-secondary">Repo URL</label>
                        <input
                            type="text"
                            value={form.repoUrl}
                            onChange={e => setForm(f => ({ ...f, repoUrl: e.target.value }))}
                            placeholder="https://github.com/org/repo"
                            className="w-full rounded-lg border border-border bg-surface-1 p-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                        />
                    </div>

                    {/* Branch — only shown when repoUrl is set */}
                    {form.repoUrl.trim() !== '' && (
                        <div className="space-y-1">
                            <label className="text-xs font-medium text-text-secondary">Branch</label>
                            <input
                                type="text"
                                value={form.branchRef}
                                onChange={e => setForm(f => ({ ...f, branchRef: e.target.value }))}
                                placeholder="main"
                                className="w-full rounded-lg border border-border bg-surface-1 p-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                            />
                        </div>
                    )}

                    {/* Notify channel */}
                    <div className="space-y-1">
                        <label className="text-xs font-medium text-text-secondary">Notify channel</label>
                        <input
                            type="text"
                            value={form.notifyChannel}
                            onChange={e => setForm(f => ({ ...f, notifyChannel: e.target.value }))}
                            placeholder="telegram:123456789"
                            className="w-full rounded-lg border border-border bg-surface-1 p-3 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                        />
                        <p className="text-xs text-text-muted">Format: telegram:chatId</p>
                    </div>

                    {/* Buttons */}
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            onClick={closeForm}
                            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-2 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={() => void save()}
                            disabled={saving || !form.name.trim()}
                            className="rounded-md bg-azure px-3 py-1.5 text-sm font-medium text-white hover:bg-azure/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {saving ? 'Saving…' : 'Save'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
