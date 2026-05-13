// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Memory UI — Phase 4 sub-page.
 *
 * Three-column tier viewer (hot / active / cold) filterable by
 * namespace via a left sidebar. Search box at the top runs through
 * the embedding-aware /entries endpoint (delegates to searchMemory
 * when q is set + tier ≠ cold). Eviction settings live in a card at
 * the bottom of the sidebar.
 *
 * Each memory row has per-tier promote/demote buttons and a delete
 * button. Single-file layout keeps the Phase 4 surface compact.
 */

import { useState } from 'react'
import { Database, Loader2, Flame, Activity, Snowflake, ChevronUp, ChevronDown, Trash2, Search, Save } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@web/context/workspace'
import {
    useMemoryEntries,
    useMemoryNamespaces,
    useEvictionSettings,
    patchMemoryTier,
    deleteMemoryEntry,
    patchEvictionSettings,
    type MemoryTier,
    type MemoryEntryView,
    type EvictionSettings,
} from '@web/lib/memory-client'

const TIERS: Array<{ value: MemoryTier; label: string; icon: typeof Flame }> = [
    { value: 'hot', label: 'Hot', icon: Flame },
    { value: 'active', label: 'Active', icon: Activity },
    { value: 'cold', label: 'Cold', icon: Snowflake },
]

export default function MemoryUIPage() {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null
    const [namespace, setNamespace] = useState<string>('')
    const [search, setSearch] = useState<string>('')

    const { data: namespacesData, mutate: refreshNamespaces } = useMemoryNamespaces(workspaceId)

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-sm bg-surface-1 flex items-center justify-center shrink-0">
                        <Database className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-medium text-text-primary">Memory browser</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Tiered workspace memory (hot / active / cold) with namespace slicing and semantic search.
                        </p>
                    </div>
                </div>
            </div>

            <div className="flex items-center gap-2 border-b border-border p-3">
                <div className="relative flex-1 max-w-xl">
                    <Search className="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" />
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search memory (semantic + text)…"
                        className="w-full rounded-md border border-border bg-surface-1 px-7 py-1.5 text-xs text-text-primary placeholder:text-text-muted focus-ring focus:ring-1 focus:ring-azure"
                    />
                </div>
                {search && (
                    <button
                        type="button"
                        onClick={() => setSearch('')}
                        className="text-[11px] text-text-muted hover:text-text-primary"
                    >
                        Clear
                    </button>
                )}
            </div>

            {!workspaceId ? (
                <div className="p-4">
                    <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar.
                    </div>
                </div>
            ) : (
                <div className="flex flex-1 overflow-hidden">
                    <aside className="w-56 flex-shrink-0 border-r border-border overflow-y-auto p-3 space-y-4">
                        <div>
                            <h3 className="text-[11px] uppercase tracking-wide text-text-muted">Namespaces</h3>
                            <div className="mt-2 space-y-1">
                                <button
                                    type="button"
                                    onClick={() => setNamespace('')}
                                    className={`w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                                        namespace === ''
                                            ? 'border-azure bg-surface-1 text-azure ring-1 ring-azure/40'
                                            : 'border-border bg-surface-1 text-text-muted hover:text-text-primary'
                                    }`}
                                >
                                    All namespaces
                                </button>
                                {(namespacesData?.namespaces ?? []).map(ns => {
                                    const active = namespace === ns.namespace
                                    return (
                                        <button
                                            key={ns.namespace}
                                            type="button"
                                            onClick={() => setNamespace(ns.namespace)}
                                            className={`w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors ${
                                                active
                                                    ? 'border-azure bg-surface-1 text-azure ring-1 ring-azure/40'
                                                    : 'border-border bg-surface-1 text-text-muted hover:text-text-primary'
                                            }`}
                                        >
                                            <div className="flex items-center justify-between gap-2">
                                                <span className="truncate">{ns.namespace}</span>
                                                <span className="text-[10px] tabular-nums text-text-muted">{ns.total}</span>
                                            </div>
                                            <div className="mt-0.5 text-[10px] text-text-muted">
                                                {ns.hot}h · {ns.active}a · {ns.cold}c
                                            </div>
                                        </button>
                                    )
                                })}
                            </div>
                        </div>
                        <EvictionCard workspaceId={workspaceId} />
                    </aside>

                    <main className="flex-1 overflow-y-auto p-4">
                        <div className="grid gap-3 lg:grid-cols-3">
                            {TIERS.map(tier => (
                                <TierColumn
                                    key={tier.value}
                                    workspaceId={workspaceId}
                                    tier={tier.value}
                                    label={tier.label}
                                    Icon={tier.icon}
                                    namespace={namespace || undefined}
                                    query={search || undefined}
                                    onChanged={() => { void refreshNamespaces() }}
                                />
                            ))}
                        </div>
                    </main>
                </div>
            )}
        </div>
    )
}

// ── Tier column ──────────────────────────────────────────────────────────

interface TierColumnProps {
    workspaceId: string
    tier: MemoryTier
    label: string
    Icon: typeof Flame
    namespace?: string
    query?: string
    onChanged: () => void
}

function TierColumn({ workspaceId, tier, label, Icon, namespace, query, onChanged }: TierColumnProps) {
    const { data, mutate, isLoading } = useMemoryEntries(workspaceId, {
        tier,
        namespace,
        q: query,
        limit: 50,
    })
    const [pending, setPending] = useState<string | null>(null)

    async function promote(entry: MemoryEntryView, next: MemoryTier) {
        setPending(entry.id)
        try {
            await patchMemoryTier(workspaceId, entry.id, next)
            await mutate()
            onChanged()
            toast.success(`Moved to ${next}`)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Move failed')
        } finally {
            setPending(null)
        }
    }

    async function remove(entry: MemoryEntryView) {
        setPending(entry.id)
        try {
            await deleteMemoryEntry(workspaceId, entry.id)
            await mutate()
            onChanged()
            toast.success('Deleted')
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Delete failed')
        } finally {
            setPending(null)
        }
    }

    return (
        <div className="rounded-sm border border-border bg-surface-1">
            <div className="flex items-center justify-between border-b border-border p-3">
                <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-azure" />
                    <h3 className="text-sm font-medium text-text-primary">{label}</h3>
                </div>
                <span className="text-[11px] text-text-muted tabular-nums">
                    {data ? `${data.items.length}` : '—'}
                </span>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-2 space-y-2">
                {isLoading ? (
                    <div className="flex items-center justify-center py-6 text-xs text-text-muted">
                        <Loader2 className="mr-2 h-3 w-3 animate-spin" /> Loading…
                    </div>
                ) : !data || data.items.length === 0 ? (
                    <div className="py-6 text-center text-[11px] text-text-muted">No entries.</div>
                ) : (
                    data.items.map(entry => {
                        const isPending = pending === entry.id
                        const canPromote = tier !== 'hot'
                        const canDemote = tier !== 'cold'
                        const nextUp: MemoryTier | null = tier === 'cold' ? 'active' : tier === 'active' ? 'hot' : null
                        const nextDown: MemoryTier | null = tier === 'hot' ? 'active' : tier === 'active' ? 'cold' : null
                        return (
                            <div key={entry.id} className="rounded-md border border-border bg-surface-1 p-2">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] uppercase tracking-wide text-text-muted">{entry.type}</span>
                                            <span className="text-[10px] text-text-muted">{entry.namespace}</span>
                                            {typeof entry.similarity === 'number' && (
                                                <span className="text-[10px] text-azure tabular-nums">
                                                    sim {entry.similarity.toFixed(2)}
                                                </span>
                                            )}
                                        </div>
                                        <p className="mt-1 line-clamp-3 text-[11px] text-text-primary leading-snug">
                                            {entry.shorthand || entry.content}
                                        </p>
                                        <div className="mt-1 text-[10px] text-text-muted">
                                            {new Date(entry.created_at).toLocaleDateString()}
                                        </div>
                                    </div>
                                    <div className="flex flex-shrink-0 flex-col gap-1">
                                        {canPromote && nextUp && (
                                            <button
                                                type="button"
                                                disabled={isPending}
                                                onClick={() => void promote(entry, nextUp)}
                                                aria-label={`Promote to ${nextUp}`}
                                                className="rounded-md border border-border bg-surface-1 p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
                                            >
                                                <ChevronUp className="h-3 w-3" />
                                            </button>
                                        )}
                                        {canDemote && nextDown && (
                                            <button
                                                type="button"
                                                disabled={isPending}
                                                onClick={() => void promote(entry, nextDown)}
                                                aria-label={`Demote to ${nextDown}`}
                                                className="rounded-md border border-border bg-surface-1 p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
                                            >
                                                <ChevronDown className="h-3 w-3" />
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            disabled={isPending}
                                            onClick={() => void remove(entry)}
                                            aria-label="Delete"
                                            className="rounded-md border border-border bg-surface-1 p-1 text-text-muted hover:text-rose-400 disabled:opacity-30"
                                        >
                                            {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )
                    })
                )}
            </div>
        </div>
    )
}

// ── Eviction card ───────────────────────────────────────────────────────

function EvictionCard({ workspaceId }: { workspaceId: string }) {
    const { data, mutate, isLoading } = useEvictionSettings(workspaceId)
    const [draft, setDraft] = useState<EvictionSettings | null>(null)
    const [saving, setSaving] = useState(false)

    const current = draft ?? data?.eviction

    async function persist(patch: Partial<EvictionSettings>) {
        setSaving(true)
        try {
            const result = await patchEvictionSettings(workspaceId, patch)
            setDraft({ ...result.eviction })
            await mutate()
            toast.success('Eviction settings saved')
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    if (isLoading || !current || !data) {
        return (
            <div className="rounded-sm border border-border bg-surface-1 p-3 text-[11px] text-text-muted">
                Loading eviction…
            </div>
        )
    }

    return (
        <div className="rounded-sm border border-border bg-surface-1 p-3 space-y-2">
            <div className="flex items-center justify-between">
                <h3 className="text-[11px] uppercase tracking-wide text-text-muted">Eviction</h3>
                <button
                    type="button"
                    role="switch"
                    aria-checked={current.enabled}
                    disabled={saving}
                    onClick={() => void persist({ enabled: !current.enabled })}
                    className={`relative h-4 w-8 rounded-full border transition-colors ${
                        current.enabled ? 'border-azure bg-azure/30' : 'border-border bg-surface-1'
                    }`}
                >
                    <span
                        className={`absolute top-0.5 h-3 w-3 rounded-full transition-transform ${
                            current.enabled ? 'translate-x-4 bg-azure' : 'translate-x-0.5 bg-muted'
                        }`}
                    />
                </button>
            </div>
            <div>
                <label className="text-[10px] text-text-muted">Cold max age (days)</label>
                <input
                    type="number"
                    min={data.bounds.coldMaxAgeDays.min}
                    max={data.bounds.coldMaxAgeDays.max}
                    value={current.coldMaxAgeDays}
                    onChange={e => setDraft({ ...current, coldMaxAgeDays: Number(e.target.value) })}
                    className="mt-0.5 w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary"
                />
            </div>
            <div>
                <label className="text-[10px] text-text-muted">Active max age (days)</label>
                <input
                    type="number"
                    min={data.bounds.activeMaxAgeDays.min}
                    max={data.bounds.activeMaxAgeDays.max}
                    value={current.activeMaxAgeDays}
                    onChange={e => setDraft({ ...current, activeMaxAgeDays: Number(e.target.value) })}
                    className="mt-0.5 w-full rounded-md border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary"
                />
            </div>
            <button
                type="button"
                disabled={saving}
                onClick={() => void persist({
                    coldMaxAgeDays: current.coldMaxAgeDays,
                    activeMaxAgeDays: current.activeMaxAgeDays,
                })}
                className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-azure/50 bg-surface-1 px-2 py-1 text-[11px] text-azure hover:border-azure disabled:opacity-50"
            >
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
            </button>
        </div>
    )
}
