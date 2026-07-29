// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * /app/workbench — Works Phase 7 workbench pane.
 *
 * A minimal two-column view that lists a user's pinned works and
 * renders the active one on the right. Pinning is done from the
 * ArtifactPanel "Workbench" pill; this page is where the user comes
 * back to iterate on them. The renderer passes `chrome={false}` so
 * we don't get a recursive "Send to workbench" button inside the
 * pane.
 */

import { useMemo, useState, useEffect } from 'react'
import { Pin, PinOff, FileText } from 'lucide-react'

import { useWorkspaceId } from '@web/context/workspace'
import { KindBadge } from '@web/components/works/KindBadge'
import { WorkRenderer, resolveKind } from '@web/components/works/WorkRenderer'
import { useWorkbenchPins, type WorkbenchPin } from './use-workbench-pins'

export default function WorkbenchPage() {
    const WS_ID = useWorkspaceId()
    const { pins, loading, error, unpin } = useWorkbenchPins(WS_ID)
    const [activeId, setActiveId] = useState<string | null>(null)
    const [filter, setFilter] = useState('')

    useEffect(() => {
        if (!activeId && pins.length > 0) {
            setActiveId(pins[0]!.pinId)
        }
    }, [pins, activeId])

    const filtered = useMemo(() => {
        if (!filter.trim()) return pins
        const needle = filter.toLowerCase()
        return pins.filter(p =>
            (p.work.filename || '').toLowerCase().includes(needle)
        )
    }, [pins, filter])

    const active: WorkbenchPin | null = useMemo(
        () => pins.find(p => p.pinId === activeId) ?? null,
        [pins, activeId],
    )

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-start justify-between gap-4 pb-4">
                <div className="min-w-0">
                    <h1 className="text-2xl font-medium text-text-primary">Workbench</h1>
                    <p className="mt-0.5 text-sm text-text-muted">
                        {pins.length} pinned work{pins.length === 1 ? '' : 's'} — iterate without losing context.
                    </p>
                </div>
            </div>

            {error && (
                <div className="rounded-md border border-red-400/40 bg-red-500/10 text-xs text-red-300 px-3 py-2 mb-3">
                    Failed to load pins: {error}
                </div>
            )}

            <div className="flex flex-col lg:flex-row gap-4 flex-1 min-h-0">
                {/* Left panel — pinned list */}
                <div className="w-full lg:w-[280px] shrink-0 flex flex-col gap-2 lg:overflow-y-auto">
                    <input
                        type="text"
                        placeholder="Filter pins…"
                        value={filter}
                        onChange={e => setFilter(e.target.value)}
                        className="w-full px-3 py-1.5 rounded-md bg-surface-1 border border-border text-[12px] text-text-primary placeholder:text-text-muted focus-ring focus:border-azure/60"
                    />
                    {loading && pins.length === 0 && (
                        <div className="text-xs text-text-muted italic p-3">Loading…</div>
                    )}
                    {!loading && filtered.length === 0 && (
                        <div className="rounded-sm border border-dashed border-border p-6 text-center">
                            <Pin className="h-6 w-6 text-text-muted mx-auto mb-2" />
                            <p className="text-xs text-text-muted">
                                {filter ? 'No pins match your filter.' : 'Pin a work from the artifact panel to get started.'}
                            </p>
                        </div>
                    )}
                    {filtered.map(p => {
                        const selected = p.pinId === activeId
                        const kind = resolveKind(p.work)
                        return (
                            <div
                                key={p.pinId}
                                className={`group rounded-sm border px-3 py-2.5 cursor-pointer transition-colors ${
                                    selected
                                        ? 'border-azure/50 bg-azure/5'
                                        : 'border-border bg-surface-1/40 hover:bg-surface-1/70'
                                }`}
                                onClick={() => setActiveId(p.pinId)}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5 min-w-0">
                                            <FileText className="h-3 w-3 text-text-muted shrink-0" />
                                            <span className="text-xs font-medium text-text-primary truncate">
                                                {p.work.filename}
                                            </span>
                                        </div>
                                        <div className="mt-1 flex items-center gap-1.5">
                                            <KindBadge kind={kind} />
                                            <span className="text-[10px] text-text-muted">
                                                {new Date(p.pinnedAt).toLocaleDateString()}
                                            </span>
                                        </div>
                                    </div>
                                    <button
                                        onClick={e => {
                                            e.stopPropagation()
                                            unpin(p.pinId).catch((err) => console.error('[workbench] unpin failed', err))
                                            if (selected) setActiveId(null)
                                        }}
                                        className="inline-flex h-8 w-8 items-center justify-center rounded-sm shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 focus-ring transition-opacity text-text-muted hover:text-red-400"
                                        title="Unpin"
                                        aria-label={`Unpin ${p.work.filename}`}
                                    >
                                        <PinOff className="h-3.5 w-3.5" />
                                    </button>
                                </div>
                            </div>
                        )
                    })}
                </div>

                {/* Right pane — active work */}
                <div className="flex-1 min-w-0 min-h-[320px] lg:min-h-0 rounded-sm border border-border bg-surface-1/20 overflow-hidden">
                    {active ? (
                        <WorkRenderer
                            work={active.work}
                            chrome={false}
                            onAction={() => { /* workbench is a leaf view */ }}
                        />
                    ) : (
                        <div className="h-full flex items-center justify-center text-text-muted text-sm">
                            Select a pinned work to view it here.
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
