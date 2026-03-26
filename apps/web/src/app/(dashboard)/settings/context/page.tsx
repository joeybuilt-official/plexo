// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, Suspense } from 'react'
import {
    BookOpen, Plus, Trash2, Edit, RefreshCw, Save, AlertCircle,
    Check, X, ChevronDown, ChevronRight,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

const API = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

// ── Types ─────────────────────────────────────────────────────────────────────

type Priority = 'critical' | 'high' | 'normal' | 'low' | 'background'

interface ContextBlock {
    id: string
    workspaceId: string
    extensionName: string
    name: string
    description: string | null
    content: string
    contentType: string
    priority: Priority
    enabled: boolean
    tokenCount: number
    tags: string[]
    ttl: number | null
    expiresAt: string | null
    createdAt: string
    updatedAt: string
}

interface BudgetInfo {
    totalTokens: number
    budgetLimit: number
    utilization: number
    byExtension: Record<string, number>
    activeContextCount: number
}

interface FormState {
    name: string
    description: string
    content: string
    priority: Priority
    tags: string
    ttl: string
}

const EMPTY_FORM: FormState = { name: '', description: '', content: '', priority: 'normal', tags: '', ttl: '' }
const PRIORITY_ORDER: Priority[] = ['critical', 'high', 'normal', 'low', 'background']
const BUDGET_LIMIT = 51200

// ── Primitive components ──────────────────────────────────────────────────────

function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            className={`min-h-[44px] rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30 disabled:opacity-40 w-full ${className ?? ''}`}
            {...props}
        />
    )
}

function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return (
        <textarea
            className={`min-h-[44px] w-full resize-none rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30 leading-relaxed ${className ?? ''}`}
            {...props}
        />
    )
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
    return (
        <button
            type="button"
            onClick={onChange}
            disabled={disabled}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-azure focus:ring-offset-2 focus:ring-offset-zinc-950 ${disabled ? 'opacity-40 cursor-not-allowed' : ''} ${checked ? 'bg-azure' : 'bg-zinc-700'}`}
        >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
    )
}

function Field({ label, description, children, counter }: { label: string; description?: string; children: React.ReactNode; counter?: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-secondary">{label}</label>
                {counter}
            </div>
            {children}
            {description && <p className="text-xs text-text-muted">{description}</p>}
        </div>
    )
}

// ── Priority helpers ──────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<Priority, string> = {
    critical: 'bg-red-900/30 text-red-400 border border-red-700/40',
    high: 'bg-amber-900/30 text-amber border border-amber-700/40',
    normal: 'bg-blue-900/30 text-blue-400 border border-blue-700/40',
    low: 'bg-zinc-800/50 text-text-muted border border-border',
    background: 'bg-zinc-900/30 text-zinc-500 border border-zinc-800/40',
}

function PriorityBadge({ priority }: { priority: Priority }) {
    return (
        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide ${PRIORITY_COLORS[priority]}`}>
            {priority}
        </span>
    )
}

// ── Budget bar ────────────────────────────────────────────────────────────────

function BudgetBar({ budget }: { budget: BudgetInfo | null }) {
    if (!budget) return null
    const pct = Math.min(budget.utilization * 100, 100)
    const barColor = pct < 60 ? 'bg-green-500' : pct < 85 ? 'bg-amber-500' : 'bg-red-500'
    const textColor = pct < 60 ? 'text-green-400' : pct < 85 ? 'text-amber' : 'text-red-400'

    return (
        <div className="rounded-xl border border-border bg-surface-1/40 p-4">
            <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-text-secondary">Token Budget</span>
                <span className={`text-sm font-mono font-medium ${textColor}`}>
                    {budget.totalTokens.toLocaleString()} / {budget.budgetLimit.toLocaleString()}
                </span>
            </div>
            <div className="h-2 w-full rounded-full bg-zinc-800 overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-300 ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="flex items-center justify-between mt-1.5">
                <span className="text-xs text-text-muted">{budget.activeContextCount} active context{budget.activeContextCount !== 1 ? 's' : ''}</span>
                <span className={`text-xs font-medium ${textColor}`}>{pct.toFixed(1)}% utilized</span>
            </div>
        </div>
    )
}

// ── Context card ──────────────────────────────────────────────────────────────

function ContextCard({ ctx, onToggle, onEdit, onDelete }: {
    ctx: ContextBlock
    onToggle: (id: string, enabled: boolean) => void
    onEdit: (ctx: ContextBlock) => void
    onDelete: (id: string) => void
}) {
    const isUser = ctx.extensionName === '_user'
    const isExpired = ctx.expiresAt && new Date(ctx.expiresAt) < new Date()

    return (
        <div className={`rounded-lg border bg-surface-1/40 p-4 transition-colors ${ctx.enabled ? 'border-border' : 'border-border/50 opacity-60'} ${isExpired ? 'border-red-800/40' : ''}`}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-medium text-text-primary truncate">{ctx.name}</h3>
                        <PriorityBadge priority={ctx.priority} />
                        {isExpired && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-900/30 text-red-400 border border-red-700/40 uppercase tracking-wide">
                                expired
                            </span>
                        )}
                    </div>
                    {ctx.description && (
                        <p className="text-xs text-text-muted mt-1 line-clamp-2">{ctx.description}</p>
                    )}
                    <div className="flex items-center gap-3 mt-2 text-xs text-text-muted">
                        <span className="font-mono">{ctx.tokenCount.toLocaleString()} tokens</span>
                        {ctx.tags.length > 0 && (
                            <span className="truncate">{ctx.tags.join(', ')}</span>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                    {isUser && (
                        <>
                            <button
                                onClick={() => onEdit(ctx)}
                                className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
                                title="Edit"
                            >
                                <Edit className="h-3.5 w-3.5" />
                            </button>
                            <button
                                onClick={() => onDelete(ctx.id)}
                                className="p-1.5 rounded-md text-text-muted hover:text-red-400 hover:bg-red-950/30 transition-colors"
                                title="Delete"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                            </button>
                        </>
                    )}
                    <Toggle checked={ctx.enabled} onChange={() => onToggle(ctx.id, !ctx.enabled)} />
                </div>
            </div>
        </div>
    )
}

// ── Delete confirmation ───────────────────────────────────────────────────────

function DeleteConfirm({ name, onConfirm, onCancel }: { name: string; onConfirm: () => void; onCancel: () => void }) {
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="bg-surface-1 border border-border rounded-xl p-6 max-w-sm w-full mx-4 shadow-xl">
                <div className="flex items-center gap-2 mb-3">
                    <AlertCircle className="h-5 w-5 text-red-400" />
                    <h3 className="text-sm font-semibold text-text-primary">Delete Context</h3>
                </div>
                <p className="text-sm text-text-muted mb-4">
                    Are you sure you want to delete <span className="font-medium text-text-primary">{name}</span>? This action cannot be undone.
                </p>
                <div className="flex justify-end gap-2">
                    <button onClick={onCancel} className="min-h-[44px] px-4 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-surface-2 transition-colors">
                        Cancel
                    </button>
                    <button onClick={onConfirm} className="min-h-[44px] px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors">
                        Delete
                    </button>
                </div>
            </div>
        </div>
    )
}

// ── Create / Edit form ────────────────────────────────────────────────────────

function ContextForm({ initial, onSubmit, onCancel, saving }: {
    initial: FormState
    onSubmit: (form: FormState) => void
    onCancel: () => void
    saving: boolean
}) {
    const [form, setForm] = useState<FormState>(initial)
    const isEdit = initial.name !== ''

    const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm(prev => ({ ...prev, [k]: v }))

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault()
        if (!form.name.trim() || !form.content.trim()) return
        onSubmit(form)
    }

    return (
        <form onSubmit={handleSubmit} className="rounded-xl border border-azure/30 bg-surface-1/40 p-4 sm:p-5">
            <div className="flex items-center gap-2 mb-4">
                <BookOpen className="h-4 w-4 text-azure" />
                <h2 className="text-sm font-semibold text-text-primary">{isEdit ? 'Edit Context' : 'New Context'}</h2>
            </div>

            <div className="flex flex-col gap-4">
                <Field label="Name" description="Short identifier for this context block (max 100 characters)">
                    <Input
                        value={form.name}
                        onChange={e => set('name', e.target.value)}
                        placeholder="e.g. Company Knowledge Base"
                        maxLength={100}
                        required
                    />
                </Field>

                <Field
                    label="Description"
                    description="Brief explanation of what this context provides (max 500 characters)"
                    counter={<span className="text-xs text-text-muted font-mono">{form.description.length}/500</span>}
                >
                    <Textarea
                        value={form.description}
                        onChange={e => set('description', e.target.value)}
                        placeholder="Describes the purpose and scope of this context block"
                        maxLength={500}
                        rows={2}
                    />
                </Field>

                <Field
                    label="Content"
                    description="The context content injected into the system prompt"
                    counter={<span className="text-xs text-text-muted font-mono">{form.content.length.toLocaleString()}/50,000</span>}
                >
                    <Textarea
                        value={form.content}
                        onChange={e => set('content', e.target.value)}
                        placeholder="Enter context content here..."
                        maxLength={50000}
                        rows={8}
                        required
                    />
                </Field>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    <Field label="Priority">
                        <select
                            value={form.priority}
                            onChange={e => set('priority', e.target.value as Priority)}
                            className="min-h-[44px] w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary focus:border-azure focus:outline-none"
                        >
                            {PRIORITY_ORDER.map(p => (
                                <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                            ))}
                        </select>
                    </Field>

                    <Field label="Tags" description="Comma-separated">
                        <Input
                            value={form.tags}
                            onChange={e => set('tags', e.target.value)}
                            placeholder="e.g. docs, internal"
                        />
                    </Field>

                    <Field label="TTL (seconds)" description="Leave empty for no expiry">
                        <Input
                            type="number"
                            value={form.ttl}
                            onChange={e => set('ttl', e.target.value)}
                            placeholder="e.g. 3600"
                            min={0}
                        />
                    </Field>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="min-h-[44px] px-4 py-2 text-sm rounded-lg border border-border text-text-secondary hover:bg-surface-2 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        disabled={saving || !form.name.trim() || !form.content.trim()}
                        className="min-h-[44px] px-4 py-2 text-sm rounded-lg bg-azure text-white hover:bg-azure/90 disabled:opacity-40 transition-colors flex items-center gap-2"
                    >
                        {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        {isEdit ? 'Update' : 'Create'}
                    </button>
                </div>
            </div>
        </form>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ContextLibraryPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
                <RefreshCw className="h-4 w-4 animate-spin" /> Loading context library...
            </div>
        }>
            <ContextLibraryContent />
        </Suspense>
    )
}

function ContextLibraryContent() {
    const { workspaceId: ctxId } = useWorkspace()
    const WS_ID = ctxId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    const [contexts, setContexts] = useState<ContextBlock[]>([])
    const [budget, setBudget] = useState<BudgetInfo | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // Form state
    const [showForm, setShowForm] = useState(false)
    const [editingCtx, setEditingCtx] = useState<ContextBlock | null>(null)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)

    // Delete state
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

    // Collapsed extension groups
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

    // ── Fetch ─────────────────────────────────────────────────────────────────

    const fetchData = useCallback(async () => {
        if (!WS_ID) return
        setLoading(true)
        setError(null)
        try {
            const [ctxRes, budgetRes] = await Promise.all([
                fetch(`${API}/api/v1/context/${WS_ID}`),
                fetch(`${API}/api/v1/context/${WS_ID}/budget`),
            ])
            if (!ctxRes.ok) throw new Error(`Failed to load contexts (${ctxRes.status})`)
            const ctxData = await ctxRes.json() as { items: ContextBlock[] }
            setContexts(ctxData.items)
            if (budgetRes.ok) {
                setBudget(await budgetRes.json() as BudgetInfo)
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchData() }, [fetchData])

    // ── Mutations ─────────────────────────────────────────────────────────────

    const flash = () => { setSaved(true); setTimeout(() => setSaved(false), 2000) }

    const handleCreate = async (form: FormState) => {
        if (!WS_ID) return
        setSaving(true)
        try {
            const body: Record<string, unknown> = {
                name: form.name.trim(),
                description: form.description.trim() || undefined,
                content: form.content,
                contentType: 'text/plain',
                priority: form.priority,
                tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
            }
            if (form.ttl) body.ttl = parseInt(form.ttl, 10)

            const res = await fetch(`${API}/api/v1/context/${WS_ID}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (!res.ok) throw new Error(`Create failed (${res.status})`)
            setShowForm(false)
            flash()
            await fetchData()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Create failed')
        } finally {
            setSaving(false)
        }
    }

    const handleUpdate = async (form: FormState) => {
        if (!WS_ID || !editingCtx) return
        setSaving(true)
        try {
            const body: Record<string, unknown> = {
                name: form.name.trim(),
                description: form.description.trim() || undefined,
                content: form.content,
                priority: form.priority,
                tags: form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : [],
            }
            if (form.ttl) body.ttl = parseInt(form.ttl, 10)

            const res = await fetch(`${API}/api/v1/context/${WS_ID}/${editingCtx.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (!res.ok) throw new Error(`Update failed (${res.status})`)
            setEditingCtx(null)
            flash()
            await fetchData()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Update failed')
        } finally {
            setSaving(false)
        }
    }

    const handleToggle = async (id: string, enabled: boolean) => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API}/api/v1/context/${WS_ID}/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled }),
            })
            if (!res.ok) throw new Error(`Toggle failed (${res.status})`)
            setContexts(prev => prev.map(c => c.id === id ? { ...c, enabled } : c))
            // Refresh budget since token counts shift
            const budgetRes = await fetch(`${API}/api/v1/context/${WS_ID}/budget`)
            if (budgetRes.ok) setBudget(await budgetRes.json() as BudgetInfo)
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Toggle failed')
        }
    }

    const handleDelete = async () => {
        if (!WS_ID || !deleteTarget) return
        try {
            const res = await fetch(`${API}/api/v1/context/${WS_ID}/${deleteTarget.id}`, { method: 'DELETE' })
            if (!res.ok) throw new Error(`Delete failed (${res.status})`)
            setDeleteTarget(null)
            flash()
            await fetchData()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Delete failed')
        }
    }

    const openEdit = (ctx: ContextBlock) => {
        setEditingCtx(ctx)
        setShowForm(false)
    }

    const openCreate = () => {
        setEditingCtx(null)
        setShowForm(true)
    }

    const cancelForm = () => {
        setShowForm(false)
        setEditingCtx(null)
    }

    // ── Group contexts by extension ───────────────────────────────────────────

    const grouped = contexts.reduce<Record<string, ContextBlock[]>>((acc, ctx) => {
        const key = ctx.extensionName
        ;(acc[key] ??= []).push(ctx)
        return acc
    }, {})

    // Sort: _user first, then alphabetical
    const groupKeys = Object.keys(grouped).sort((a, b) => {
        if (a === '_user') return -1
        if (b === '_user') return 1
        return a.localeCompare(b)
    })

    const toggleGroup = (key: string) => {
        setCollapsed(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
        })
    }

    const groupLabel = (key: string) => key === '_user' ? 'User' : key

    // ── Render ────────────────────────────────────────────────────────────────

    if (!WS_ID) {
        return (
            <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
                <AlertCircle className="h-4 w-4" /> No workspace selected.
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6 pb-12">
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-lg font-semibold text-text-primary flex items-center gap-2">
                        <BookOpen className="h-5 w-5 text-azure" />
                        Context Library
                    </h1>
                    <p className="text-sm text-text-muted mt-1">Context blocks injected into every task&apos;s system prompt</p>
                </div>
                <div className="flex items-center gap-2">
                    {saved && (
                        <span className="flex items-center gap-1 text-xs text-green-400">
                            <Check className="h-3.5 w-3.5" /> Saved
                        </span>
                    )}
                    <button
                        onClick={() => void fetchData()}
                        disabled={loading}
                        className="min-h-[44px] p-2 rounded-lg border border-border text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-40"
                        title="Refresh"
                    >
                        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                        onClick={openCreate}
                        disabled={showForm || !!editingCtx}
                        className="min-h-[44px] px-4 py-2 text-sm rounded-lg bg-azure text-white hover:bg-azure/90 disabled:opacity-40 transition-colors flex items-center gap-2"
                    >
                        <Plus className="h-4 w-4" /> Add Context
                    </button>
                </div>
            </div>

            {/* Error */}
            {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg border border-red-800/40 bg-red-950/20 text-sm text-red-400">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <button onClick={() => setError(null)} className="p-1 hover:bg-red-900/30 rounded">
                        <X className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}

            {/* Budget bar */}
            <BudgetBar budget={budget} />

            {/* Create form */}
            {showForm && (
                <ContextForm initial={EMPTY_FORM} onSubmit={handleCreate} onCancel={cancelForm} saving={saving} />
            )}

            {/* Edit form */}
            {editingCtx && (
                <ContextForm
                    initial={{
                        name: editingCtx.name,
                        description: editingCtx.description ?? '',
                        content: editingCtx.content,
                        priority: editingCtx.priority,
                        tags: editingCtx.tags.join(', '),
                        ttl: editingCtx.ttl ? String(editingCtx.ttl) : '',
                    }}
                    onSubmit={handleUpdate}
                    onCancel={cancelForm}
                    saving={saving}
                />
            )}

            {/* Loading */}
            {loading && contexts.length === 0 && (
                <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
                    <RefreshCw className="h-4 w-4 animate-spin" /> Loading contexts...
                </div>
            )}

            {/* Empty state */}
            {!loading && contexts.length === 0 && (
                <div className="rounded-xl border border-border bg-surface-1/40 p-8 text-center">
                    <BookOpen className="h-8 w-8 text-text-muted mx-auto mb-3" />
                    <p className="text-sm text-text-muted">No context blocks yet. Add one to get started.</p>
                </div>
            )}

            {/* Grouped context list */}
            {groupKeys.map(key => {
                const items = grouped[key]
                const isCollapsed = collapsed.has(key)
                return (
                    <div key={key} className="flex flex-col gap-2">
                        <button
                            onClick={() => toggleGroup(key)}
                            className="flex items-center gap-2 py-1 text-xs font-semibold text-text-muted uppercase tracking-wider hover:text-text-secondary transition-colors"
                        >
                            {isCollapsed
                                ? <ChevronRight className="h-3.5 w-3.5" />
                                : <ChevronDown className="h-3.5 w-3.5" />
                            }
                            {groupLabel(key)}
                            <span className="text-text-muted font-normal normal-case tracking-normal">({items.length})</span>
                        </button>
                        {!isCollapsed && (
                            <div className="flex flex-col gap-2 pl-1">
                                {items
                                    .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority))
                                    .map(ctx => (
                                        <ContextCard
                                            key={ctx.id}
                                            ctx={ctx}
                                            onToggle={handleToggle}
                                            onEdit={openEdit}
                                            onDelete={id => {
                                                const c = contexts.find(x => x.id === id)
                                                if (c) setDeleteTarget({ id, name: c.name })
                                            }}
                                        />
                                    ))
                                }
                            </div>
                        )}
                    </div>
                )
            })}

            {/* Delete confirmation */}
            {deleteTarget && (
                <DeleteConfirm
                    name={deleteTarget.name}
                    onConfirm={() => void handleDelete()}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
        </div>
    )
}
